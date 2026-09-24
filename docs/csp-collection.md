# CSP Hash Collection — Integration Strategy

How each integration collects inline script hashes for `manifest.csp.pages` at build time. This doc
is the integration-side counterpart to `docs/csp-injection-strategy.md` (SW-side CSP header
emission) and `docs/ssr-verification.md` (SW-side response verification). The canonical case catalog
lives in `docs/verification-cases.md`.

## Overview

`manifest.csp.pages` maps a page key to `{ scripts, attrs }` — the SHA-256 hashes of every inline
`<script>` body and `on*` attribute value that appears on that page. At runtime the SW emits a
`Content-Security-Policy` header containing these hashes (see `docs/csp-injection-strategy.md`),
replacing any origin-emitted CSP wholesale.

Keys are matched by the SW using exact-or-prefix logic:

-   Exact key (`/dashboard`) — matches only that path.
-   Prefix key (`/posts/`) — matches any path starting with `/posts/`. Used for parameterised routes
    where all IDs share the same static inline scripts.

Empty entries (`{ scripts: [], attrs: [] }`) tell the SW to inject a CSP that blocks all inline
scripts on that page. This is the correct default when a route has no known-good inline scripts to
allowlist — under the trust model, unlisted inline `<script>` is untrusted.

## Route classes

The integration subdivides routes by how much is knowable at build time. This drives the extractor
functions in each integration (`extractFixedRoutes`, `extractEnumerableRoutes` in `@dappfence/astro`
and `@dappfence/next`).

-   **staticPages** — prerendered HTML on disk (SSG, static export). Walk `outDir`, hash each
    `.html`, extract inline script + attr hashes. Full-body hash also recorded in `manifest.files`.
-   **fixedRoute** — param-free SSR (e.g. `/live`). Boot the built server, fetch the URL once,
    extract hashes from the response.
-   **enumerableRoute** — parameterized SSR with an enumerable ID set (`getStaticPaths()` in Astro,
    `generateStaticParams` in Next.js). Enumerate all IDs at build time, fetch each concrete URL,
    produce one manifest entry per ID.
-   **probedRoute** — parameterized SSR, IDs not enumerable. Currently **unsupported**. Earlier
    designs proposed fetching a sentinel probe URL and storing hashes under a prefix key; that was
    dropped because the "one probe URL represents all IDs" assumption breaks the moment a route's
    inline scripts vary per ID. Routes in this class must either add `getStaticPaths` /
    `generateStaticParams` (converting to enumerableRoute) or accept that all inline scripts on the
    route will be blocked (see § What breaks below).

## Astro

### Source of dynamic routes

The `astro:routes:resolved` hook — Astro passes the full resolved route list before the build runs.
`extractDynamicRoutes` filters to `!r.isPrerendered`.

### Inline hash collection

| Route class     | Technique                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| staticPages     | `generateManifest` (manifest-tools) walks `outDir` and calls `extractInlineHashesFromHtml` on every `.html` file                                             |
| fixedRoute      | Build-time server: imports `server/entry.mjs`, starts it on a random port, fetches the URL, extracts inline hashes from the HTML response                    |
| enumerableRoute | Imports the Vite-compiled chunk from `server/chunks/`, calls `mod.page().getStaticPaths()` to enumerate concrete URLs, then same fetch+extract as fixedRoute |
| probedRoute     | Unsupported — see § Route classes                                                                                                                            |

### Prefix key derivation

`routePatternToPrefixKey('/posts/[id]')` strips from the first `[` back to the last `/`:
`/posts/[id]` → `/posts/`, `/blog/[year]/[slug]` → `/blog/`. Exact paths pass through unchanged.
Only used for enumerableRoute when the integration chooses to collapse per-ID entries into a single
prefix entry (all IDs must share identical inline hashes).

## Next.js

### Source of dynamic routes

`readDynamicRoutes` reads three `.next/` manifests written by `next build`:

| Manifest                                          | What it contributes                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `routes-manifest.json`                            | Rewrite source patterns; `dynamicRoutes[].page` (e.g. `/blog/[slug]`)                                             |
| `prerender-manifest.json`                         | The set of already-prerendered paths — used to exclude from the dynamic list                                      |
| `pages-manifest.json` + `app-paths-manifest.json` | Any page/route not in the prerender set is SSR; App Router keys are normalised (`/dashboard/page` → `/dashboard`) |

### Inline hash collection

| Route class     | Technique                                                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staticPages     | `walkHtmlFiles` reads `.next/server/app/` and `.next/server/pages/`, calls `extractInlineScriptHashes` + `extractInlineAttrHashes` on each `.html` file                                                                          |
| fixedRoute      | Programmatic Next.js server via `next({ dev: false, dir }); await app.prepare(); const handler = app.getRequestHandler()`. Fetch the URL, extract inline hashes                                                                  |
| enumerableRoute | Read the concrete paths enumerated by `next build` in `prerender-manifest.json` under `dynamicRoutes`, fetch each via the programmatic server. Routes fully prerendered (no `dynamicParams`) are already in the staticPages walk |
| probedRoute     | Unsupported                                                                                                                                                                                                                      |

## Shared output shape

Both integrations converge on the same shape passed to `generateManifest`:

```js
csp: {
  connectOrigins: ["https://api.example.com"],
  pages: {
    '/index.html':    { scripts: ['sha256-...'], attrs: [] },  // staticPages, hashes from walk
    '/live':          { scripts: ['sha256-...'], attrs: [] },  // fixedRoute, hashes from fetch
    '/dashboard':     { scripts: [], attrs: [] },              // fixedRoute, no inline scripts
    '/posts/hello':   { scripts: ['sha256-...'], attrs: [] },  // enumerableRoute, per-ID entry
  }
}
```

`manifest-tools/generateManifest` merges `cspBuiltPages` (from the static file walk) with the
`csp.pages` map passed by the integration. The integration's entries take precedence.

## What breaks in the first-step

Under the current hash-based CSP, any inline `<script>` whose body varies per request cannot be
covered. The integration cannot compute a hash for a body that doesn't exist yet.

Concretely:

-   **Next.js RSC (`force-dynamic`)** — the `<script>self.__next_f.push(…)</script>` chunks embed
    per-request wire-format payloads. No pre-computable hash. CSP blocks them; React unmounts the
    server-rendered tree. Accepted as first-step regression.
-   **Astro server islands (Case 10)** — per-request URL / prop-hash values in the auto-emitted init
    script. Blocked.
-   **`<script>window.__STATE__ = {…}</script>` per-request state assignments** — no pre-computable
    hash. Blocked.
-   **probedRoute routes** — no way to enumerate ID-specific inline scripts. All inline scripts on
    the route blocked; the route effectively requires refactoring to `getStaticPaths` /
    `generateStaticParams` or moving per-request data to a JSON data island.

The forcing-function guidance the integration should surface: move per-request data to
`<script type="application/json">` islands (Case 8 / Case 20 Pattern B). Islands are non-executable
and not subject to CSP `script-src` — no hash required.

## Direction — no schema growth beyond `csp.pages` + `dataIslands`

**Skeleton records were designed and dropped (2026-06-25) along with the streaming rewriter.** The
manifest schema at this integration layer stays flat:

-   **`csp.pages[route].scripts`** — SHA-256 hashes of build-time-stable inline `<script>` bodies.
    Same shape as today; only relevant for scripts that survive the CSP-only direction (a nonced
    bootstrap, plus optional defense-in-depth listings of static inline blocks).
-   **`csp.pages[route].attrs`** — SHA-256 hashes of `on*` attribute values, when any are declared.
    Emits `script-src-attr 'unsafe-hashes' 'sha256-…'`.
-   **`dataIslands[route]`** — declared `<script type="application/json">` bodies with either a
    byte-exact hash (build-stable payload) or a JSON-schema reference (per-request payload verified
    structurally by the SW's JSON extractor). Not scripts to CSP; the SW does its own body check.

Everything else the retired skeleton design tried to cover (per-request executable inline scripts,
RSC push, `window.__STATE__ = …`, Astro island init) is out of scope at the manifest layer.
Developers refactor those emissions to data islands or accept that CSP blocks them at the browser.

### Retired direction — skeleton records per route

Kept for historical rationale. Once shipped, the SW would have gained streaming parse + skeleton
verify + nonce rewrite, and the manifest would have grown to record:

-   **Per route: a structural skeleton record** — element types, attribute names, positions;
    dynamic-leaf slot definitions (which text nodes and attribute values are per-request) with
    heuristics.
-   **Per per-request inline script: a skeleton shape** — RSC Flight tree structure with dynamic
    leaves, `window.<name> = <literal>` template with a leaf slot for `<literal>`, Astro island init
    call with dynamic URL / prop-hash slots.
-   **Per build-time-stable inline script: byte-exact hash** — same as today's
    `csp.pages[…].scripts`.

The integration extractor would have grown accordingly (per-route tokenize + skeleton capture);
under the current direction the extractor just walks built HTML for inline hashes and declared data
islands.

## Honest pushback

-   **`csp.pages` hash lists don't scale to per-request scripts.** This is the design's ceiling
    under the first-step approach; every framework mode that emits per-request executable inline
    scripts breaks. The forcing function (move to data islands) is real but not always feasible (RSC
    is framework-mandated).
-   **`probedRoute` is a persistently tempting shortcut that doesn't work.** Any design that
    proposes "fetch one probe URL to represent all IDs" fails as soon as the inline scripts vary
    with the ID — which is the default assumption for genuine parameterization. Don't re-raise.
-   **`extractInlineAttrHashes` + `'unsafe-hashes'`** — attribute-hash CSP is a real weakness when
    the body is not fully byte-hashed. An attacker who can inject HTML can clone the attribute onto
    a decoy element and trigger the handler. Emit hashes only where truly needed for legacy code;
    prefer `addEventListener` inside a hash-allowlisted `<script>` block.
