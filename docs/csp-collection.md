# CSP Hash Collection — Integration Strategy

How each integration collects inline script hashes for `csp.pages` at build time.

---

## Overview

`manifest.csp.pages` maps a page key to `{ scripts, attrs }` — the SHA-256 hashes of every inline
`<script>` block and `on*` attribute value that appears on that page. The SW injects a
`Content-Security-Policy` header using these hashes before the browser sees the response.

Keys are matched by the SW using exact-or-prefix logic:

-   Exact key (`/dashboard`) — matches only that path.
-   Prefix key (`/posts/`) — matches any path that starts with `/posts/`. Used for parameterised
    routes where all IDs share the same static inline scripts.

Empty entries (`{ scripts: [], attrs: [] }`) are emitted for dynamic routes that have no inline
scripts. This tells the SW to inject a CSP that blocks all inline scripts on that page, which is the
correct default — the page has no known-good inline scripts to allowlist.

---

## Verification modes

These classify pages by the guarantee DappFence can provide. They are defined in
`docs/csp-injection-strategy.md`.

-   **staticPages** — prerendered pages (SSG, static export). Full body hash + CSP. Any modification
    to any byte in the response is detected.
-   **stableInlineScripts** — SSR pages whose inline scripts are identical on every render. No body
    hash (content changes per request); CSP is the primary protection.
-   **dynamicRSC** — Next.js `force-dynamic` routes (opt-in). CSP blocks RSC push scripts;
    `dappfence.js` re-executes them after strict pattern validation. Data injection residual
    remains.

---

## SSR collection route classes

The Astro integration subdivides SSR routes by how much is knowable at build time. This drives
`extractFixedRoutes`, `extractEnumerableRoutes`, `extractProbedPatterns` in the code.

-   **fixedRoute** — param-free SSR (e.g. `/live`, `/api/version`): boot the built server, fetch the
    URL once, parse the HTML. Produces an exact key in `csp.pages`.
-   **enumerableRoute** — parameterized SSR + `getStaticPaths()` (e.g. `/snippets/[id]`): enumerate
    all valid IDs via `getStaticPaths()`, fetch each concrete URL, produce one exact key per ID.
-   **probedRoute** — parameterized SSR, IDs not enumerable: fetch one sentinel probe URL
    (`/posts/__probe__`), extract hashes from that response, store under a prefix key (`/posts/`).
    Weakest guarantee — assumes all IDs share the same static inline scripts.

---

## Astro

### Source of dynamic routes

`astro:routes:resolved` hook — Astro passes the full resolved route list before the build runs.
`extractDynamicRoutes` filters to `!r.isPrerendered`.

### Inline script hash collection

| Route class     | Route type                                            | Technique                                                                                                                                                  |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staticPages     | Prerendered HTML on disk                              | `generateManifest` (manifest-tools) walks `outDir` and calls `extractInlineHashesFromHtml` on every `.html` file                                           |
| fixedRoute      | SSR, no URL params (e.g. `/live`)                     | Build-time server: imports `server/entry.mjs`, starts it on a random port, fetches the URL, parses the HTML response                                       |
| enumerableRoute | SSR + `getStaticPaths()`                              | Imports the Vite-compiled chunk from `server/chunks/`, calls `mod.page().getStaticPaths()` to enumerate concrete URLs, then same fetch+parse as fixedRoute |
| probedRoute     | SSR + URL params, no enumeration (e.g. `/posts/[id]`) | Fetches a sentinel probe URL (`/posts/__probe__`), parses the response for hashes, stores them under the prefix key `/posts/`                              |

### Prefix key derivation

`routePatternToPrefixKey('/posts/[id]')` strips from the first `[` back to the last `/`:
`/posts/[id]` → `/posts/`, `/blog/[year]/[slug]` → `/blog/`. Exact paths pass through unchanged.

---

## Next.js

### Source of dynamic routes

`readDynamicRoutes` reads three `.next/` manifests written by `next build`:

| Manifest                                          | What it contributes                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `routes-manifest.json`                            | Rewrite source patterns; `dynamicRoutes[].page` (e.g. `/blog/[slug]`)                                             |
| `prerender-manifest.json`                         | The set of already-prerendered paths — used to exclude from the dynamic list                                      |
| `pages-manifest.json` + `app-paths-manifest.json` | Any page/route not in the prerender set is SSR; App Router keys are normalised (`/dashboard/page` → `/dashboard`) |

### Inline script hash collection (current)

| Route class                                | Technique                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| staticPages                                | `walkHtmlFiles` reads `.next/server/app/` and `.next/server/pages/`, calls `extractInlineScriptHashes` + `extractInlineAttrHashes` on each `.html` file |
| fixedRoute / enumerableRoute / probedRoute | Empty entry only — `{ scripts: [], attrs: [] }` via `routePatternToPrefixKey`                                                                           |

### Gap — SSR pages get no hash extraction

Next.js SSR pages (those not in the prerender manifest) are never fetched at build time, so their
inline scripts are never extracted. The CSP injected for these pages will block all inline scripts,
including any legitimate bootstrapper scripts the framework emits on every SSR response.

### Proposed fix — Next.js programmatic server (mirrors Astro)

Next.js ships a programmatic API that produces the same `handler(req, res)` shape as Astro's
`entry.mjs`:

```js
const { default: next } = await import('next');
const app = next({ dev: false, dir: projectRoot });
await app.prepare();
const handler = app.getRequestHandler();
```

This lets us reuse the same spin-up-server → fetch → parse-HTML loop already implemented in
`hashSSRRoutes` (Astro). `next` is already a peer dependency — no new dependency required.

| Route class     | Route type                                      | Technique                                                                                                                                                            |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fixedRoute      | SSR, no URL params (e.g. `/dashboard`)          | Start programmatic server, fetch the URL, parse the HTML                                                                                                             |
| enumerableRoute | SSR + `generateStaticParams`                    | Read the concrete paths already enumerated by `next build` in `prerender-manifest.json` under `dynamicRoutes`, then fetch+parse each one via the programmatic server |
| probedRoute     | SSR + URL params, IDs not in prerender manifest | Fetch a sentinel probe URL, parse, store under prefix key                                                                                                            |

Note on enumerableRoute: `prerender-manifest.json` is already read by `readDynamicRoutes` —
currently only to build the exclusion set. The enumerableRoute change reuses the same data: the
`dynamicRoutes` entries inside it are the concrete paths to fetch and hash. Routes that use
`generateStaticParams` and are fully prerendered (no `dynamicParams`) are already in the staticPages
walk and never reach this path. enumerableRoute only applies when `dynamicParams = true` (the
default) — known IDs are prerendered and in the manifest, while unknown IDs fall back to SSR.

---

## Shared output shape

Both integrations converge on the same final shape passed to `generateManifest`:

```js
csp: {
  pages: {
    '/index.html':    { scripts: ['sha256-...'], attrs: [] },  // staticPages, hashes from walk
    '/live':          { scripts: ['sha256-...'], attrs: [] },  // fixedRoute, hashes from fetch
    '/posts/':        { scripts: ['sha256-...'], attrs: [] },  // probedRoute, hashes from probe
    '/dashboard':     { scripts: [], attrs: [] },              // fixedRoute, no inline scripts
  }
}
```

`manifest-tools/generateManifest` merges `cspBuiltPages` (from the static file walk) with the
`csp.pages` map passed by the integration. The integration's entries take precedence.
