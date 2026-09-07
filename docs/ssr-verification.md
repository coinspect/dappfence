# SSR / On-demand Route Verification

This document describes how DappFence verifies server-rendered responses. The canonical case catalog
and trust-model derivation live in `docs/verification-cases.md`; this doc is the SSR-specific slice:
what the SW does with an SSR navigation or an SSR-fetched partial, why the earlier extraction-based
designs were retired, and where the current implementation stands.

## What we're verifying

SSR responses come in two consumption shapes:

-   **Navigation** (`destination: "document"`) — the browser parses the response as a document and
    executes `<script>` elements according to the document's CSP. Cases 6, 7, 9, 19, 20, 21.
-   **Fetched partial** (`destination: ""`) — a host page fetches HTML and injects it via
    `innerHTML` / `dangerouslySetInnerHTML`. `<script>` elements inserted this way _do not execute_
    (HTML parser rule). Runtime containment of the injected DOM is governed by the _host document's_
    CSP, not the partial response's CSP (which is inert for this pattern). Cases 3, 4, 8, 10, 13,
    14, 15, 18.

The security question for each shape:

-   For navigation: prevent any attacker-controlled `<script>` from executing.
-   For fetched partial: detect structural tampering in the fragment; execution containment is the
    host document's CSP job.

## Trust model recap

Per `docs/verification-cases.md` § "The trust model": the origin is assumed compromised. Any header,
nonce, inline script, or CSP directive the origin emits is untrusted. The signed manifest is the
sole runtime source of truth. Everything below must derive from it.

## Current mechanism (first-step, ships today)

For navigation responses:

1. SW verifies the response body:
    - **staticPages** (SSG, static export) — full-body SHA-256 match against `manifest.files`.
    - **stableInlineScripts** (SSR with build-time-stable inline scripts) — no full-body hash;
      `manifest.csp.pages[pageKey]` lists SHA-256 hashes of each stable inline `<script>` body and
      `on*` attribute value, emitted in the SW's CSP header.
2. SW emits its own `Content-Security-Policy` header derived entirely from the manifest, replacing
   any origin-emitted CSP wholesale (see `docs/csp-injection-strategy.md`).

For fetched HTML partials:

1. SW hashes the response body (static partials — Cases 1, 2, 16) and compares against
   `manifest.files`.
2. Dynamic partials (Cases 3, 4, 8, 10, 13, 14, 15) are not currently verified at the response level
   — see § What breaks in the first step below.

### What breaks in the first-step

Under this CSP posture, any `<script>` whose body is not byte-stable across requests is blocked.
This includes:

-   Next.js RSC `<script>self.__next_f.push(…)</script>` chunks — bodies contain per-request RSC
    wire-format payloads. Blocking these breaks hydration and unmounts the server-rendered tree; the
    page appears blank. Accepted as a first-step regression; the fix requires the streaming rewriter
    (below).
-   Astro server-island init scripts (Case 10) — per-request URL / prop-hash values in the init
    call.
-   `<script>window.__STATE__ = {…}</script>` per-request state assignments (Case 14).

The forcing-function guidance for developers hitting these: move per-request data to
`<script type="application/json">` data islands (Case 20 Pattern B). Islands are non-executable (CSP
`script-src` does not apply) and readable via `document.getElementById(id).textContent`.

## Direction — CSP + JSON islands (first step) + targeted RSC parser (next)

**First step (skeleton hashing / general-shape parser retired 2026-06-25).** The SW emits
`script-src-elem 'nonce-N' *` with a fresh N per response, tags only its own bootstrap script with
N, and strips the origin CSP. Every other inline `<script>` reaches the browser un-nonced and is
blocked. Per-request state that today ships as inline `<script>` (RSC push chunks,
`window.__STATE__ = …`, framework hydration payloads) must be refactored by the app into inert
`<script type="application/json">` data islands, read via `JSON.parse(el.textContent)`. Data blocks
are not scripts; CSP doesn't gate them, and the SW byte-hashes their bodies when the manifest
declares them. External scripts pass CSP via `*` and are hash-verified by the SW at fetch time.

This closes both "attacker injects new `<script>`" and "attacker tampers with existing `<script>`"
uniformly, without any per-shape response-body parser. It also closes the composition gap for
fetched partials: every navigation response gets an SW-emitted CSP, so pages that later inject
fetched partial HTML via innerHTML have real containment guarantees (parser inertness for `<script>`

-   host-document CSP for other execution vectors).

**Next step (planned) — a targeted RSC wire-format parser.** Aimed at the single per-request-inline
shape that Next.js RSC apps depend on. The SW streams the response, identifies
`<script>self.__next_f.push(…)</script>` boundaries, hands each body to the RSC parser, verifies the
wire-format payload against the route's manifest entry, and applies `nonce=N` iff verified. Once
shipped, Cases 6/7/20-Pattern-C/21 become compatible. Only the RSC format is in scope; other
per-request inline shapes (Pattern A `window.__STATE__ = …`, Astro island init, dynamic-nonce
scripts) stay in the "refactor to a data island or external script" bucket.

### What was retired — general-shape parser

Retained as historical rationale for anyone re-opening the "let's verify every per-request body"
question. The retired design was:

1. SW generates a fresh unpredictable nonce N per navigation response.
2. SW emits CSP with `script-src 'nonce-N'` in the header, before body streams.
3. SW streams the body through an HTML tokenizer, identifies `<script>` element boundaries.
4. For each `<script>`:
    - Verify the body against the manifest's skeleton for this route.
    - Build-time-stable body → byte-exact match against a listed hash.
    - Per-request body → structural skeleton and dynamic-leaf heuristics **for every framework
      shape** — RSC Flight tree, `window.<name> = <literal>`, Astro island init, JSON island
      position, importmap validation, and so on.
5. Verified → SW writes `nonce=N` on the element. Unverified → no nonce → browser blocks.

Rejected because the SW-side cost (streaming HTML tokenizer + per-shape parsers for every framework
inline shape + manifest schema for skeletons + variant enumeration for bounded conditionals) was
judged higher than the developer-side cost of refactoring per-request state into data islands. The
forcing function is the point: apps that can't refactor aren't compatible with DappFence's
guarantees, which is a load-bearing property, not a limitation.

The planned RSC parser is deliberately _not_ the retired general-shape parser. It handles one wire
format (the highest-value framework target), has a narrow interface (in: script body; out:
verified/rejected), and doesn't grow the manifest schema beyond a per-route RSC skeleton entry.

## Why the earlier extraction designs were retired

Earlier drafts of this doc proposed two designs to verify SSR responses. Both were dropped when the
trust model was tightened and the streaming-rewriter design landed.

### Option 1 — Marker-based skeleton hashing (retired)

Developers annotated dynamic regions with HTML comments
(`<!-- df:dynamic -->…<!-- /df:dynamic -->`); the SW stripped markers and hashed the remaining
skeleton.

Failure modes:

-   Developer must annotate every dynamic region; missing one produces a runtime violation.
-   Annotation drifts over time as templates evolve.
-   Doesn't cover per-request inline scripts (RSC push, per-request state assignments) — those
    aren't a "region", they're script bodies that need their own parse.

### Option 2 — DOMParser extraction with set-membership manifest entries (retired)

The SW buffered the full response, parsed it with `DOMParser`, extracted three sets — inline
scripts, `on*` handlers, importmaps — and did set-membership checks against manifest entries
(`pageKey#scripts`, `pageKey#handlers`, `pageKey#importmap`).

Failure modes:

-   **Set-membership over hashes can't cover per-request inline scripts.** RSC push bodies and
    `window.__STATE__` assignments produce a new hash every request; no manifest set can list them
    all. Any framework that emits per-request executable inline scripts breaks under this model.
-   **Full buffering before delivery.** The set-membership result is only known at EOF; the SW can't
    start streaming to the browser without giving up the ability to block on violation. This defeats
    the entire streaming-hydration story for RSC / Suspense.
-   **`DOMParser` is a full-document parser.** For streaming responses it forces buffer-then-parse
    even where a token-boundary detector would suffice.

The streaming rewriter subsumes both: skeleton match and per-shape parsers handle per-request script
bodies; token-boundary streaming avoids full buffering except where structural variant enumeration
forces it (see below).

## Verification tiers

Cross-referenced from `docs/verification-cases.md` § "Verification limits":

| Tier                              | Cases                      | Mechanism under current direction                                                                                       |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Strong — static assets            | 1, 2, 16                   | Full SHA-256 of response body                                                                                           |
| Strong — declared data islands    | 8, 14, 20 Pattern B        | Byte hash of `<script type="application/json">` body (inert data block; CSP does not gate)                              |
| Execution-safe (fetched partials) | 3, 4, 13, 15, 18           | Allowlist route; execution safety from host-document CSP + `innerHTML` parser inertness. No content-integrity claim.    |
| Execution-safe (SSR navigation)   | 9, 19, 20 Pattern A, 21    | Host-document CSP with SW-generated nonce; only nonced bootstrap runs. Per-request inline must be refactored to island. |
| Fallback — code-layer             | any body not covered above | Verify the JS bundle + server templates producing the response, not the response itself                                 |

## Practical guidance for developers

-   **Prefer JSON data islands over executable inline scripts** for per-request data delivery (Case
    8, Case 20 Pattern B). Islands are non-executable, CSP-inert, framework-agnostic, and require no
    wire-format parser in the SW.
-   **Prefer `getStaticPaths` / `generateStaticParams`** where the ID set is enumerable. This
    converts parameterized SSR into per-ID static hashes (Case 2 pattern), which is the strongest
    guarantee available.
-   **Bootstrapper inline scripts must be byte-stable across renders.** Theme detection, framework
    init calls, etc. must not embed per-request data. When per-request data is needed, source it
    from a JSON island the bootstrapper reads.
-   **Case 15 (conditional elements) forces buffering under variant enumeration.** For high-traffic
    routes where buffering latency matters, either list the variants deliberately (small bounded
    set) or emit a server-side variant marker on the root element so the SW can identify the variant
    from the first token and stream from there.
-   **`force-dynamic` in Next.js App Router breaks under the first-step CSP.** RSC push bodies can't
    be pre-hashed. If your app requires per-request RSC, either wait for the streaming rewriter or
    convert `force-dynamic` routes to SSG + client-side fetches for the truly dynamic data.

## Known limits and honest pushback

-   **Skeleton hashing assumes a fixed structure.** Most real SSR components have at least one
    conditional element (auth state, feature flags, error banners). Case 15 is the common case, not
    the exception — the "streaming SSR" narrative works cleanly only for the rare fixed-skeleton
    route.
-   **Dynamic-leaf heuristics are load-bearing but weak.** "Looks like an integer / ISO timestamp /
    URL" won't survive an attacker who controls the leaf value. Content integrity of dynamic values
    is out of scope, but heuristics must still prevent structural escape (e.g., text-node heuristics
    must reject bytes that would break the parser state).
-   **RSC Flight-protocol parser is a maintenance liability.** React does not document the wire
    format, and it changes between versions. Supporting Next.js RSC means tracking upstream. Scope
    per-framework parsers deliberately — the cost per framework is real.
-   **Set-membership over per-request script hashes is fundamentally not viable** (retired Option
    2's failure). Any design that reappears wanting to "hash the extracted scripts and check against
    a manifest set" is walking back into this trap.
