# Verification cases

Each case illustrates a distinct class of HTTP response that DappFence must handle. Runnable
examples for every case live in the
[dappfence-examples](https://github.com/coinspect/dappfence-examples) repository.

This document is the canonical case list. It combines the case catalog with the trust-model,
composition, and mechanism discussion that determine which verification strategy applies where.

---

## Interception points

DappFence can intercept requests at two distinct points, each with a different verification
strategy:

| Request type         | Fetch `destination` | Who triggers it                     | DappFence intercept point    |
| -------------------- | ------------------- | ----------------------------------- | ---------------------------- |
| Full page navigation | `"document"`        | Browser (address bar, link click)   | Navigation / page load event |
| Partial / fetch      | `""`                | JavaScript (`fetch()`, XHR)         | Service worker fetch event   |
| Script loading       | `"script"`          | Browser (`<script src>`, `import`)  | Service worker fetch event   |
| Stylesheet loading   | `"style"`           | Browser (`<link rel="stylesheet">`) | Service worker fetch event   |
| Font loading         | `"font"`            | Browser (CSS `@font-face`)          | Service worker fetch event   |
| Image loading        | `"image"`           | Browser (`<img src>`, CSS `url()`)  | Service worker fetch event   |

**Error responses:** DappFence treats 4xx and 5xx responses that carry a body the same as 200 — the
body is hashed and compared against the manifest. A 304 Not Modified response carries no body;
DappFence reuses the cached hash from the prior 200 response for that URL.

The example repo covers all interception points above. Most routes are HTML partials fetched by JS,
but `/dashboard` (Next.js) and the `/live` page are full page navigations, and Case 16 demonstrates
`destination: "script"` for static JS assets. The `/dashboard` RSC case is particularly interesting
because the same URL produces different responses depending on _how_ it is reached: a hard
navigation returns a full HTML document, while a client-side route change causes React to fetch the
RSC wire-format payload as a `destination: ""` request.

---

## The mechanism at a glance

DappFence uses one uniform mechanism for every document (navigation) response. The service worker
sits in the response path as a **streaming parser + verifier + rewriter**:

1. Generate a fresh, unpredictable `nonce N` per response.
2. Emit the CSP header immediately (before body):
   `script-src 'nonce-N'; script-src-attr 'none'; object-src 'none'; base-uri 'self'; default-src 'self' <manifest allowlisted origins>;`
3. Stream the response through an HTML parser that identifies `<script>` element boundaries.
4. For each `<script>` element:
    - Buffer only that element's body.
    - Verify its content against the signed skeleton in the manifest — either byte-exact match for
      build-time-stable scripts or structural match with dynamic-leaf heuristics for per-request
      scripts (e.g., RSC push payloads, per-request `window.__STATE__` assignments).
    - If verified: rewrite the `nonce` attribute to `N` (or add it if absent). Forward the element.
    - If not verified: leave without a matching nonce. Browser blocks it.
5. All other bytes stream through untouched.

Why this shape:

-   **CSP is committed at response start.** Hashes can't be added after — but nonces can be
    committed up front and used to gate elements the SW verifies as it streams.
-   **Streaming is preserved.** RSC Suspense, chunked SSR, and static responses all flow through the
    same path with no buffer-then-emit round trip.
-   **No origin trust is needed.** The nonce is SW-generated; the verification is content-derived
    from the signed manifest.
-   **No hash listing in CSP.** With per-script verification and rewrite, hashes in CSP would be
    redundant defense-in-depth that also breaks streaming. The SW is the trust root for per-response
    decisions.

For **assets** (JS bundles, CSS, images, static partials), no CSP mechanism applies — the SW
byte-hashes the response body and compares against the signed manifest. This is DappFence's
highest-value guarantee: JS bundles are the primary attack target and their bytes are locked.

For **fetched HTML partials** consumed via `innerHTML` / `dangerouslySetInnerHTML`, static bodies
are verified with a byte hash; dynamic bodies are not verified body-side under the current CSP-only
direction — execution safety comes from host-document CSP + `innerHTML` parser inertness (see
"Composition" below and the retired-design notes for the original skeleton-hash approach).

The rest of this document walks through the case catalog and then returns to the trust model that
justifies this design.

---

## Client consumption patterns

Every case's client-side story collapses onto one of five patterns. This is the taxonomy of what the
browser JS actually does with each response — distinct from the server-side rendering pattern, which
varies more.

1. **`fetch + innerHTML`** — HTML partial consumed via `container.innerHTML = text` / React
   `dangerouslySetInnerHTML`. Cases 1, 2, 3, 4, 8 (wrapper), 13, 14, 15, 18. Most common pattern in
   the catalog.
2. **`fetch + .json()`** — JSON API consumption. Cases 5, 17. No HTML, no execution vector on the
   client side.
3. **`JSON.parse(getElementById(id).textContent)`** — inert JSON data island read-out. The server
   embeds state as `<script id="foo" type="application/json">{ "user": "…" }</script>`. Because the
   `type` is not `text/javascript`, the browser treats the element as a **data block** — it stores
   the body as `textContent` but never executes it. Client code then reads the raw text and parses
   it. This is what Next.js does with `__NEXT_DATA__`, Nuxt with `__NUXT_STATE__`, Astro with its
   island props, etc. Contrast with `<script>window.__STATE__ = {…}</script>` (pattern 5 in the
   framework-handled cases), whose body **is** executable JS and therefore has to satisfy CSP
   `script-src-elem`. Data-island scripts sidestep `script-src-elem` entirely; the only trust check
   DappFence needs is that the JSON body matches the manifest's skeleton (byte-exact for
   build-time-stable state; structural for per-request state). Cases: Case 8 (after
   fetch+innerHTML), Case 20 Pattern B (from doc-embedded island; no client fetch).
4. **`<script src=…>` at doc parse** — static-asset load. Case 16 (developer-authored); implicit in
   every navigation case's bundle load, but Case 16 is the one that owns the property.
5. **Browser navigation + framework runtime handles the rest** — developer writes zero explicit
   fetch/parse code; React RSC, Astro islands, Next Server Actions, or a 302 redirect handles it.
   Cases 6a/6b/7/9/10/11/12/19/20/21.

Only patterns 1–3 involve developer-authored client JS. Patterns 4–5 are implicit or
framework-handled.

### Server-pattern × client-consumption reference

| Case | Route                             | Server-side pattern                                                                      | Client-side consumption                                                              |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1    | `/partials/prerendered`           | Prerendered static HTML                                                                  | fetch + innerHTML                                                                    |
| 2    | `/partials/:id`                   | Parameterized static (`getStaticPaths`/`generateStaticParams`)                           | fetch + innerHTML                                                                    |
| 3    | `/partials/ssr`                   | SSR partial, fixed skeleton, varying leaves                                              | fetch + innerHTML                                                                    |
| 4    | `/partials/stream`                | SSR partial, chunked/streamed                                                            | fetch + innerHTML                                                                    |
| 5    | `/api/counter`                    | JSON API                                                                                 | fetch + `.json()`                                                                    |
| 6a   | `/dashboard` (hard nav)           | RSC page — server-component tree + inline `self.__next_f.push` scripts                   | Browser nav; React hydrates from embedded push scripts. Zero developer client code.  |
| 6b   | `/dashboard?_rsc=…`               | Same route, `text/x-component` transport                                                 | React client router fetches; zero developer code.                                    |
| 7    | `/dashboard` w/ Suspense          | RSC streaming — late push scripts                                                        | Same as 6a; React progressive hydration.                                             |
| 8    | `/partials/script-data`           | SSR partial with `<script type="application/json" id="…">` inside                        | fetch + innerHTML _then_ `JSON.parse(getElementById(id).textContent)`                |
| 9    | `/live`                           | Full SSR page — dynamic body, no RSC                                                     | Browser nav; no developer client code for this specifically.                         |
| 10   | `/islands` + `/_server-islands/*` | Astro server islands (auto-emitted init script)                                          | Framework auto-emits `fetch + swap`; zero developer client code.                     |
| 11   | `POST /actions`                   | Next Server Action (`'use server'` fn)                                                   | Developer writes `fn()`; React handles POST + `text/x-component` reply.              |
| 12   | `/redirect → 302`                 | Redirect response, no body                                                               | Browser follows `Location`; zero developer code.                                     |
| 13   | `/partials/nonce`                 | SSR partial with `<script nonce>` and origin-emitted CSP header                          | fetch + innerHTML — nonce meaningless on host doc.                                   |
| 14   | `/partials/init-data`             | SSR partial with `<script>window.__WIDGET_STATE__={…}</script>`                          | fetch + innerHTML — script INERT (parser rule); production shape reads `window.VAR`. |
| 15   | `/partials/conditional`           | SSR partial, **varying skeleton** (`{cond && <Row/>}`) — 2² variants                     | fetch + innerHTML — indistinguishable from Case 3 on client.                         |
| 16   | `/static-demo.js`                 | Static JS file in `public/`                                                              | `<script src>` at doc parse — browser runs (`destination: "script"`).                |
| 17   | `/api/item/:id`                   | Dynamic API, non-enumerable IDs                                                          | fetch + `.json()`                                                                    |
| 18   | `/partials/variable-list`         | SSR partial, unbounded N `<li>` children                                                 | fetch + innerHTML — indistinguishable from Cases 3/15 on client.                     |
| 19   | `/partials/dynamic/:id`           | Parameterized SSR _navigation_, no `getStaticPaths`                                      | Browser nav; page-specific inline scripts blocked.                                   |
| 20   | `/inline-data`                    | SSR _page_ with `<script>window.__serverTime=…</script>` + JSON island                   | Browser nav; Pattern A runs at doc parse; Pattern B via `JSON.parse`.                |
| 21   | `/news`                           | ISR page: build-time render + `revalidate=60s`; RSC push scripts change per regeneration | Browser nav; React hydrates. ISR angle is only about _when_ bytes were generated.    |
| 22   | `<unmatched>` → 404               | Framework 404 body (Astro `404.astro`, Next `not-found.tsx`) with hydration scripts      | Browser nav; framework hydrates. Same shape as Case 1 (Astro) or Case 9 (Next).      |
| 23   | `/throws` → 500                   | SSR error path (Astro `500.astro`, Next `error.tsx` React error boundary)                | Browser nav; framework hydrates the error UI. Same shape as Case 9.                  |
| 24   | `/partials/inferred`              | Auto-inferred dynamic Next route — no `dynamic` export, `headers()` flips the flag       | fetch + innerHTML — same shape as Case 3.                                            |

The case-by-case sections that follow describe the mechanism DappFence uses for each; the
"Cross-case subtleties" section near the end draws comparisons that are clearer once all 24 cases
have been read.

---

## Fixture convention

Every case below has a working fixture at the Route path in `@dappfence/example-nextjs` and/or
`@dappfence/example-astro`, per the case's `Frameworks:` field. Only cases where the fixture carries
context beyond the Route (a specific configuration, an alternate demo route, or "implicit — any
bundle") include an explicit `**Fixture:**` line.

---

## Case 1 — Static pre-rendered partial

**Route:** `GET /partials/prerendered` **Frameworks:** Astro + Next.js **Render time:** Build time
(SSG) **Destination:** `""` (fetched by JS)

The response is an HTML fragment rendered once at build time and served as a static file. The bytes
never change between requests.

**Verification:** Full SHA-256 hash recorded in the manifest at build time. DappFence compares the
hash on every fetch. This is identical to how static JS and CSS assets are verified — no new
capability required.

**Integration (current):** The integration fetches `/partials/prerendered` at build time, SHA-256
hashes the response body, and writes `{ "/partials/prerendered": "sha256-<hash>" }` into
`manifest.files`. The service worker looks up the path and compares on every request.

---

## Case 2 — Parameterized static partial

**Route:** `GET /partials/:id` **Frameworks:** Astro + Next.js **Render time:** Build time (SSG, one
file per ID) **Destination:** `""`

Like Case 1 but with multiple variants. Each ID maps to a distinct HTML fragment, all rendered at
build time via `getStaticPaths` / `generateStaticParams`.

**Verification:** One hash per ID in the manifest. DappFence matches the requested URL to the
correct hash entry. No new capability beyond Case 1, but requires the manifest to list all known
IDs.

**Integration (current):** The integration calls `getStaticPaths` / `generateStaticParams` to list
all valid IDs, fetches each concrete path (`/partials/service-worker`, `/partials/sha256`, …),
hashes each response, and writes one entry per ID into `manifest.files`. Unknown IDs (not in the
list) are not in the manifest and will be blocked.

---

## Case 3 — SSR partial, fixed skeleton, dynamic data

**Route:** `GET /partials/ssr` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `""`

The HTML structure (element types, class names, attribute names) is identical across every request.
Only data values differ (a counter, a timestamp, a random number from the DB module).

**Context — server-side feature, client-agnostic consumer:** SSR partials are a _server-side_
capability whose purpose is to feed a client-side HTML-swap consumer — htmx, Alpine, or a
handwritten `fetch().then(r => r.text())`. Astro makes this explicit with
`export const partial = true`; in Next.js the same shape is produced by a Route Handler returning
`text/html`. Neither framework ships a built-in client-side consumer for these responses; the swap
is always done by user code (or a third-party library) via `innerHTML` / DOM insertion.

**Threat-model context (server assumed compromised):** The attacker controls the partial bytes and
can inject anything — `<script>`, `<iframe>`, inline event handlers. Because the framework-supported
consumption path uses `innerHTML`, the browser's HTML parser does **not** execute `<script>` tags
inserted this way. Certain attribute-based execution vectors (e.g. `<img src=x onerror=…>`) do fire
on insertion, but the _host_ document's CSP (injected by DappFence for the page consuming the
partial) blocks inline event handlers unless explicitly hashed. The remaining attack surface is
therefore **content tampering** of the visible HTML (swapping numbers, links, phishing text) — which
is out of scope for DappFence, per the "Scope of guarantee" section below.

Because the framework-supported consumer never executes scripts from the fragment, executable
JavaScript inside a Case 3 partial has no supported execution path and is out of scope for this
case. Scenarios that legitimately need client-side scripting tied to server data belong in other
cases — server islands (Case 10), RSC (Cases 6/7/9/19/20/21), or JSON data islands (Case 20).

**Precondition:** The HTML structure — element count, nesting, and attribute names — must be
identical on every request. Only leaf text node values and known-dynamic attribute values (e.g.
`datetime`, `href`) may differ. If any element can appear in one response but not another
(conditional rendering based on server state), the structural skeleton is not fixed and this case
does not apply. See **Case 15** for that scenario.

**Verification:** DappFence cannot hash the full response (bytes differ every request). The approach
is _skeleton/template hashing_: strip the dynamic leaf values, serialize the structural skeleton,
and hash that. DappFence would need to know which parts of the response are structural vs. dynamic.

**Integration (current):** Allowlist. Execution safety comes from the parent page's CSP plus
`innerHTML` parser inertness at the consumption site — no body-side verification. Content integrity
for this dynamic-leaf pattern is a stated non-goal.

**Integration (retired — skeleton parser design):** Preserved as historical rationale for why
body-side verification of dynamic SSR was rejected as too costly. Kept in the doc so future
reviewers can see what the mechanism would have needed to look like if it were rebuilt.

An HTML parser processes the response as the server streams it. The parser separates the document
into two buckets:

-   **Structural parts** — element tags, class names, attribute names and their fixed values. These
    are hashed and compared against the manifest.
-   **Dynamic parts** — leaf text nodes and attribute values that vary per request (the counter, the
    random number, the timestamp). These are extracted and verified separately using heuristics
    based on their content (e.g. "looks like an integer", "looks like a UTC time string", "matches a
    known safe pattern").

The manifest stores the hash of the structural parts plus a description of what heuristics apply to
each extraction point. The service worker runs the same parser at intercept time.

This is different from the Netlify CDP regex transform: that approach strips a known fixed pattern
before hashing. The HTML parser approach works for arbitrary SSR output where the dynamic positions
are not known in advance — only the structure is fixed.

**Note on heuristic scope:** The dynamic-leaf heuristics exist to distinguish "this is where the
dynamic value lives" from "something structural has moved here". They are not a content-integrity
check on the dynamic value itself. DappFence does not attest to whether the extracted integer is
"correct" — only that the surrounding structure was not tampered with. Content integrity of dynamic
response data is out of scope; see "Scope of guarantee" below.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html

<div class="ssr-partial">
  <h2 class="title">Server stats</h2>
  <p class="stat">42</p>
  <p class="stat">0.7382</p>
  <p class="stat">2026-06-23T14:32:17.000Z</p>
</div>
```

Tags and class names are identical every request; the three text nodes change.

---

## Case 4 — Streaming SSR partial

**Route:** `GET /partials/stream` **Frameworks:** Astro + Next.js **Render time:** Request time,
chunked **Destination:** `""`

The route returns a `ReadableStream`. Items arrive as HTTP chunks with a short delay between them.
The client (`fetch().then(r => r.text())`) buffers the full response before injecting HTML.

**Verification:** Same skeleton-hashing approach as Case 3, extended to handle streaming input. The
parser is streaming-native — it processes the document incrementally as chunks arrive — so no full
buffering is required before verification begins. The parser accumulates structural tokens and
extracted dynamic parts chunk by chunk, and finalizes the hash once the stream closes.

**Integration (current):** Same as Case 3 — allowlist; execution safety via CSP + `innerHTML`
inertness at consumption.

**Integration (retired — skeleton parser design):** The manifest entry is identical in shape to
Case 3. The service worker does not need a special streaming flag because the parser already handles
partial input.

**Relationship to Case 3:** Same structural/dynamic split problem, plus the added complexity of a
chunked transport. Both are body-verification concerns under the retired skeleton-hashing design;
under the current CSP-only direction, both routes are allowlisted and execution safety comes from
host-document CSP + `innerHTML` parser inertness at the consumption site.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html
Transfer-Encoding: chunked

<ul class="stream-list">
  <li class="item">item 1</li>
...
  <li class="item">item 2</li>
...
  <li class="item">item 3</li>
</ul>
```

`...` marks inter-chunk gaps (~100 ms each). The full response is only available once the stream
closes.

---

## Case 5 — Pure JSON API

**Route:** `GET /api/counter` **Frameworks:** Astro + Next.js **Render time:** Request time
**Destination:** `""` (called via `fetch()`)

Returns JSON, not HTML. The response has no stable structure that can be hashed as a template — the
values are a counter, a random number, and a timestamp, all of which change every request.

**Verification:** There is no content to hash. DappFence can record the URL pattern in the manifest
as an _allowlisted_ endpoint (fetch is permitted, no integrity check). Any attempt to verify content
would require application-level schema validation, which is outside DappFence's scope.

**Integration (current):** The integration writes `{ "/api/counter": { type: "allowlist" } }` into
the manifest. The service worker passes these requests through without hashing. This case
establishes the boundary: not everything fetched by JS is verifiable, and the manifest must be able
to express "trusted but unverified."

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"counter":42,"random":0.7382,"time":"2026-06-23T14:32:17.000Z"}
```

Every value changes per request; there is no structural skeleton to hash.

---

## Case 6 — RSC page

**Route:** `GET /dashboard` **Frameworks:** Next.js only **Render time:** Request time (React Server
Components, `force-dynamic`) **Destination:** `"document"` on hard nav, `""` on client-side nav

This case has two sub-scenarios depending on how the page is reached.

> **Integration note (2026-06-25, updated 2026-08-19).**
>
> -   **First step (today):** RSC pages using `force-dynamic` are incompatible. RSC push chunks
>     arrive un-nonced (origin CSP stripped; SW only tags its own bootstrap with the per-response
>     nonce); the browser blocks them and React hydration fails. Apps hitting this case can drop
>     `force-dynamic` (fall back to Case 20 Pattern B) or accept incompatibility until the next step
>     lands.
> -   **Next step (planned — RSC parser):** the SW streams the response, identifies
>     `<script>self.__next_f.push(…)</script>` boundaries, hands each body to a targeted RSC
>     wire-format parser, verifies the payload against the manifest's route entry, and applies
>     `nonce=N` iff verified. Once shipped, Cases 6a and 7a become compatible for Next.js RSC pages.
> -   **What was retired, not planned again:** the _general-shape_ parser design — a single HTML
>     tokenizer that extracts every inline `<script>` and verifies each against manifest-declared
>     shapes (`window.<name> = <literal>`, Astro island init, JSON island heuristics, importmap
>     validation, and so on). Cost driver was the breadth of shapes and the framework-per-shape
>     maintenance. The RSC parser is deliberately narrow: one wire format, one high-value target.
>     Case 6/6a/6b prose below describes what verification would have looked like under either
>     approach — preserved as rationale.

### 6a — Hard navigation (`destination: "document"`)

The browser navigates directly to `/dashboard`. Next.js renders the full HTML document server-side
and sends it as a standard HTTP response. The response is a complete HTML document, but it embeds
RSC payload in inline `<script>self.__next_f.push(...)</script>` blocks that React uses to hydrate.

**Verification under the streaming SW rewriter:**

The SW-streamed parser walks the outer HTML and identifies each
`<script>self.__next_f.push(...)</script>` element. Rather than treating the body as opaque text,
the SW routes it to an **RSC wire-format parser** that walks the encoded component tree, separates
structural nodes (element types, class names, prop keys) from dynamic leaves (text content, prop
values), verifies structure against the manifest's RSC skeleton for this route, and applies
dynamic-leaf heuristics.

If the RSC payload verifies → SW writes `nonce=N` on the element → browser executes it → React
hydrates. If it fails → an element ships without a matching nonce → browser blocks it → React
hydration fails (React unmounts the server-rendered tree). The security posture: attacker cannot
smuggle non-conforming RSC payloads through; the cost of a failed verify is availability (hydration
breaks), not compromise.

**Distinction from Case 14:** `<script>self.__next_f.push([…])</script>` blocks are RSC wire-format
payloads routed to the RSC parser. Case 14 scripts carry a `window.VAR = {…}` global assignment
routed to the JS-assignment parser. The SW identifies which by the leading pattern of the script
body.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …

<!DOCTYPE html><html lang="en"><head>…</head><body>
<div id="__next">
  <h1>Dashboard</h1>
  <p class="counter">42</p>
</div>
<script nonce="<SW-N>">self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>
<script nonce="<SW-N>">self.__next_f.push([0,["$","section",null,{"children":["$","p",null,{"children":42}]}]])</script>
<script nonce="<SW-N>">self.__next_f.push([0,{"timestamp":"2026-06-23T14:32:17.000Z"}])</script>
</body></html>
```

The `nonce="<SW-N>"` attributes are written by the SW after it verified each RSC payload against the
manifest skeleton. An attacker-injected `<script>evil()</script>` (with no nonce, or with an
origin-controlled nonce that doesn't match `SW-N`) is blocked.

### 6b — Client-side navigation (`destination: ""`)

The user navigates to `/dashboard` via a `<Link>` click after the initial page load. React fetches
the RSC payload as a `fetch()` request. The response is **not HTML** — it is the RSC wire format: a
line-delimited mix of JSON references and HTML fragments.

**Verification:** The response body is passed to the RSC parser directly (no outer HTML). The parser
walks the wire format, separates structural component tree nodes from dynamic leaf values, hashes
the structure, and applies heuristic verification to the extracted dynamic parts. If verification
fails, the SW blocks the response with an error status, and the caller (React runtime) sees the
fetch fail — client-side navigation is aborted, browser falls back to hard navigation.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/x-component

0:I["(app-browser)/./src/app/dashboard/page.tsx",["app/dashboard/page"],"default"]
1:["$","div",null,{"className":"dashboard","children":[["$","h1",null,{"children":"Dashboard"}],["$","p",null,{"className":"counter","children":42}],["$","p",null,{"className":"timestamp","children":"2026-06-23T14:32:17.000Z"}]]}]
```

Line-delimited JSON. `I`-prefixed lines are module imports (structural); other lines are component
tree nodes. Dynamic values (`42`, the timestamp) appear as leaf JSON values inside the tree.

---

## Case 7 — RSC Suspense streaming

**Route:** `GET /dashboard` (same page as Case 6, with `<Suspense>` boundaries) **Frameworks:**
Next.js only **Render time:** Request time, streamed **Destination:** `"document"` on hard nav, `""`
on client-side nav

**Fixture:** `@dappfence/example-nextjs` — `/dashboard` is a `force-dynamic` route with three async
server components, two wrapped in `<Suspense>` (instant / 400 ms / 800 ms).

**Case 7 = Case 6 + streaming.** Same wire formats, same DappFence conclusions. The only new
dimension is **time**: Suspense flushes bytes in chunks over the same connection instead of a single
payload.

|                           | Case 6 (no Suspense)                     | Case 7 (with Suspense) — same shape, chunked                                                                                 |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 6a / 7a — hard nav        | HTML with all RSC push scripts at once   | Same HTML, `Transfer-Encoding: chunked`; shell first, each `<script>self.__next_f.push(…)</script>` at boundary-resolve time |
| 6b / 7b — client-side nav | `text/x-component` payload, single flush | `text/x-component`, chunked; RSC wire-format lines stream in as boundaries resolve                                           |

**Conclusions are identical to Case 6.** 7a inherits 6a's story (browser-executed inline; today
blocked under CSP-only; planned RSC parser closes it), and 7b inherits 6b's story (data in a
`fetch()` body; allowlist; safety rests on the byte-hashed client bundle). The streaming dimension
would have mattered only under the retired general-shape parser, which required buffering to decide
which shape a script fit — that would have defeated the whole point of Suspense streaming. The
planned RSC parser is streaming-native (verifies each push chunk as it arrives), so streaming isn't
a distinguishing factor for it either.

See Case 6 for wire-shape examples and the full integration story. Case 7's fixture is the same
route with `<Suspense>` added on top.

---

## Case 8 — Inline script data partial

**Route:** `GET /partials/script-data` **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR) **Destination:** `""` (fetched by JS)

An SSR partial that embeds dynamic data inside a `<script type="application/json">` tag within the
HTML fragment. This pattern is common for passing server data to client-side JS without a separate
API call.

**Verification:** The HTML parser must handle `<script>` tags specially. The tag itself is
structural (its `type` attribute, its `id`) but its text content is dynamic JSON. The parser
descends into the script content and applies JSON-aware heuristics to the extracted values —
different from plain text node heuristics.

`<script type="application/json">` is not executable — CSP `script-src` does not apply to it. So the
fragment's contents are safe from an execution-vector standpoint even before verification;
DappFence's verification here is purely structural (is the JSON island where we expect it, in the
right position?).

**Integration (current):** The fetched partial body is allowlisted (same as Case 3). The JSON data
island _inside_ the partial is the load-bearing primitive — its body is byte-hashed at build time
when the schema is stable, or verified via a JSON-schema entry in the manifest where the payload
varies. Data blocks are inert to CSP; the SW does its own body check for content integrity.

**Integration (retired — skeleton parser design):** Preserved to document the mechanism the
streaming rewriter would have used. Same HTML parser as Cases 3 and 4, extended to recognise
`<script type="application/json">` blocks and hand their content to a JSON value extractor rather
than a text node extractor. The structural hash covers the tag and its attributes; the dynamic
values inside the JSON are verified separately.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html

<div class="widget">
  <script type="application/json" id="__widget_data">
    {"count":42,"label":"visitors","updatedAt":"2026-06-23T14:32:17.000Z"}
  </script>
  <h2 class="title">Live stats</h2>
</div>
```

The `<script>` tag and its attributes (`type`, `id`) are structural; the JSON values inside
(`count`, `updatedAt`) are dynamic and need a JSON-aware extractor, not a plain text-node heuristic.

---

## Case 9 — Full SSR page

**Route:** `GET /live` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `"document"` (browser navigation)

A complete HTML page (not a partial) with dynamic content from the DB module. Unlike Cases 3–8 which
are all fetched by JS with `destination: ""`, this page is reached via browser navigation. DappFence
intercepts at the page-load level rather than via the service worker fetch event.

**Verification:** The streaming SW rewriter handles this. HTML parser walks the document, applies
skeleton verification to dynamic regions, verifies any per-request inline scripts via
skeleton/heuristic rules, and applies `nonce=N` to verified scripts.

**Integration (current):** SW-injected CSP with `script-src-elem 'nonce-N' *`. Only the SW-tagged
bootstrap script runs; every other inline is blocked. Apps with per-request executable inline on SSR
nav routes must refactor state to a JSON data island (Case 20 Pattern B) or accept that hydration
will not run for the un-nonced blocks.

**Integration (retired — skeleton parser design):** Preserved as historical rationale. Same parser
and heuristic approach as Cases 3/4. The interception point is the navigation request rather than a
plain fetch. The manifest declares the document skeleton (structural HTML + expected inline-script
shapes).

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Live | DappFence Example</title>
  <link rel="stylesheet" href="/_astro/index.BxYq3Kz.css">
</head>
<body>
  <main class="live-page">
    <h1>Live data</h1>
    <p class="counter">42</p>
    <p class="timestamp">2026-06-23T14:32:17.000Z</p>
  </main>
  <script nonce="<SW-N>" src="/_astro/hoisted.CdQ1pWK.js"></script>
</body>
</html>
```

The `<script src>` is byte-hash verified when the browser fetches it (Case 16). The nonce ensures
the tag itself was written by the SW after verifying the document skeleton.

---

## Case 10 — Astro server islands

**Route:** fetched by Astro runtime at `/_server-islands/<ComponentName>` **Frameworks:** Astro only
**Render time:** Request time (deferred, after initial page load) **Destination:** `""` (fetched by
Astro's island runtime)

**Fixture:** `@dappfence/example-astro` — `/islands` demonstrates server-island usage.

Astro's `server:defer` directive causes a component to be rendered server-side after the initial
page load. The Astro runtime fetches the component's HTML from a special `/_server-islands/` route
and injects it into the page — conceptually similar to a partial fetch, but the URL pattern and
request shape are Astro-specific.

Additionally, the parent document contains a per-request inline init script that Astro auto-emits to
drive the fetch and swap. Under the streaming SW rewriter, this init script is treated like any
other per-request inline script: the SW parses it against a signed skeleton (expected shape of an
Astro island init call, dynamic leaves for the island URL / prop hash), and if verified, applies
`nonce=N`.

**Verification of the island response:** HTML fragment (same shape as Cases 3–4). The HTML parser
approach applies. The additional challenge is that the URL contains the component name and a hash of
its props, so the manifest entry must match on a pattern rather than an exact path.

**Integration (current):** Astro server islands are **incompatible** with the CSP-only direction.
Astro emits a per-request init `<script>` per island that invokes `fetch('/_server-islands/…')` —
un-nonced inline, so it's blocked by the SW's CSP, and the islands never load. The migration path
requires either an upstream change in Astro (emit island-init logic as an external script or a data
island the client reads) or forgoing server-island usage under DappFence. Case is preserved to
document the pattern and the incompatibility so future Astro users know what to expect.

**Integration (retired — skeleton parser design):** Preserved as historical rationale for the
approach that would have kept server islands working. The integration enumerates server island
components at build time, renders each with sentinel props, skeleton-hashes the result, and writes a
pattern-matched entry into the manifest. The service worker matches `/_server-islands/<name>`
requests against the pattern.

**Example response:**

```http
GET /_server-islands/LiveIsland?e=0&p=sha256-abc123&s=&c=

HTTP/1.1 200 OK
Content-Type: text/html

<div class="live-island">
  <p class="value">42</p>
  <time class="updated" datetime="2026-06-23T14:32:17.000Z">just now</time>
</div>
```

The fragment shape matches Cases 3–4. The complication is the URL: `p=` is a hash of the props
passed to the island and changes with different prop values, so the manifest must match on
`/_server-islands/LiveIsland` as a pattern rather than an exact path.

---

## Case 11 — Next.js Server Actions

**Route:** `POST` to the page URL (e.g. `POST /actions`) **Frameworks:** Next.js only **Render
time:** Request time, triggered by form submission **Destination:** `""` (fetch POST issued by
React)

When a form with a Server Action is submitted, React issues a `POST` to the page's URL with a
special `Next-Action` header. The response is an RSC update — a diff of the component tree, not a
full page.

**Verification:** Two new dimensions compared to previous cases:

1. **Method** — this is a POST, not a GET. DappFence's current focus is GET requests. Whether POST
   responses should be verified at all is an open design question.
2. **Response format** — same RSC wire format as Case 6b, but it is a partial tree update rather
   than a full page render. The response is data fed into the RSC runtime; it is not inserted into
   the document as new inline `<script>` elements, so the streaming SW rewriter's nonce-injection
   doesn't apply. Verification is via the RSC parser inspecting the response body before delivery.

**Integration (current):** Allowlist. The response is per-request and effectively unverifiable
body-side; the manifest records the Server Action endpoint as `{ type: "allowlist" }`. Execution
safety comes from the parent page's CSP for whatever the client does with the returned data (usually
feed it back into React state, which then re-renders under the same CSP shield). The RSC-parser
body-verification path from Case 6b's Integration bullet is retired along with the streaming
rewriter.

**Example request/response:**

```http
POST /actions
Content-Type: multipart/form-data; boundary=----formdata
Next-Action: abc123def456

------formdata
Content-Disposition: form-data; name="1_"

{"value":42}
------formdata--

HTTP/1.1 200 OK
Content-Type: text/x-component

0:{"a":"$@1","f":"abc123def456","b":"xyz789"}
1:null
2:["$","div",null,{"className":"result","children":"Updated: 42"}]
```

The request carries the action ID in `Next-Action`. Line `1:null` is the action's return value; line
`2:` is the re-rendered component subtree. The action ID is structural; the return value and
re-rendered content are dynamic.

---

## Case 12 — Redirects

**Route:** `GET /redirect` **Frameworks:** Astro + Next.js **Render time:** Immediate (no body)
**Destination:** `""` or `"document"` depending on caller

A route that issues an HTTP 302 redirect to another URL. The response has no body — just a
`Location` header.

**Verification:** Several open questions for DappFence:

1. Should DappFence verify the redirect response itself? (No body to hash, but an unexpected
   redirect could be an attack vector — a tampered CDN could redirect to a malicious page.)
2. Should DappFence track which URLs are expected to redirect and to where, and flag unexpected
   redirect targets?
3. Should DappFence block a redirect to a destination not in the manifest?

**Integration (current, unimplemented):** The manifest could record
`{ "/redirect": { type: "redirect", to: "/live" } }`. The service worker would check that the
`Location` header matches the expected destination before following. This would catch a CDN-level
redirect hijack. Independent of the retired skeleton-parser work; still a valid open feature.

**Example response:**

```http
HTTP/1.1 302 Found
Location: /live
Content-Length: 0
```

No body — the only verifiable data is the `Location` header. A tampered CDN could change `/live` to
a malicious URL without touching any hashed asset.

---

## Case 13 — CSP nonce in script attribute

**Route:** `GET /partials/nonce` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `""` (fetched by JS)

The route sets a `Content-Security-Policy` response header with a per-request nonce and injects the
same nonce into a `<script nonce="…">` attribute. The nonce is a cryptographically random base64
value that changes every request.

**Verification and threat-model note:** Under the compromised-origin threat model, server-emitted
nonces cannot be trusted — the attacker with server control mints them and stamps them on arbitrary
scripts. **DappFence's SW must never propagate origin-emitted nonces into its own injected CSP.**
The SW strips the origin's `Content-Security-Policy` header entirely and replaces it with its own
(SW-nonced) CSP.

For fetched partials, the `<script nonce>` attribute value is a known-dynamic attribute — its value
is per-request. The structural hash covers the attribute _name_; the value is a dynamic slot. If the
caller ever consumes this partial via `innerHTML`, the nonce attribute is inert unless the host
document's CSP references it (which it does not, because the host CSP is DappFence-generated and
uses the SW's own nonce). The origin's nonce attribute has no effect on execution.

**Integration (current):** Any origin-emitted nonce is discarded — the SW strips the origin CSP
wholesale and emits its own. The SW's nonce is per-response and only tags the SW's own bootstrap
script. Origin-side per-request nonces on other inline scripts don't propagate; those scripts are
blocked by the browser. Case is preserved to document why "just trust the origin's nonce" was
rejected — the origin is untrusted, so its nonces are attacker-controlled by an assumption.

**Integration (retired — dynamic attribute slot design):** Preserved as historical rationale. The
manifest records `nonce` as a dynamic attribute slot on `<script>` and `<style>` elements with
heuristic `base64-random`. The verifier checks that the extracted value matches the pattern
`[A-Za-z0-9+/]+=*` with a minimum length of ~22 characters (128 bits of entropy). This heuristic
exists to detect a structural change (attribute repurposed as an injection vector); it does _not_
imbue the origin's nonce with any trust.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-dGhpcyBpcyBhIG5vbmNl'
  ← origin-emitted header; SW strips this before delivery

<div class="nonce-partial">
  <script nonce="dGhpcyBpcyBhIG5vbmNl">/* nonce-gated */</script>
  ...
</div>
```

The nonce attribute value is per-request. DappFence treats it as a known-dynamic attribute value
(stripped from the structural hash) but does not trust it or propagate it into the enforced CSP.

---

## Case 14 — Inline JS with embedded server data

**Route:** `GET /partials/init-data` **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR) **Destination:** `""` (fetched by JS)

The route returns an HTML fragment containing a `<script>` tag (no `type` attribute — plain
executable JavaScript) that assigns a server-generated object to a global variable. This is the
`window.__INIT_DATA__` / `window.__INITIAL_STATE__` pattern common in SSR frameworks, and the
`__NEXT_DATA__` pattern in Next.js.

**Verification:** Different from Case 8 (`<script type="application/json">`):

-   Case 8 content is pure JSON — the parser descends into it with a JSON value extractor.
-   Case 14 content is executable JavaScript. Dynamic values are embedded _within JS syntax_
    (`window.__WIDGET_STATE__ = {count: 42, …}`) rather than being a standalone JSON document.
    Extracting them requires a JS parser or pattern matching on the assignment expression, not just
    `JSON.parse()`.

**Note on innerHTML injection:** When this partial is injected into the host page via `innerHTML`,
the browser does **not** execute the script (HTML parser rule for innerHTML-inserted scripts).
DappFence's structural verification therefore covers only the tampering-detection role — the runtime
execution vector is closed by the browser and host CSP regardless. For scenarios where the
per-request data does need to be readable client-side, the recommended pattern is Case 8's JSON data
island, which is inert and unambiguously covered by CSP `script-src`.

**Integration (current):** Executable inline scripts carrying per-request server data are
**incompatible** — they're per-request bodies with no matching nonce, so the browser blocks them.
The migration is to a JSON data island (Case 20 Pattern B): server emits
`<script type="application/json" id="…">{…}</script>` (inert), a client reads via
`JSON.parse(getElementById(id).textContent)`. Case is preserved to document the pattern developers
must move away from and the concrete refactor.

**Integration (retired — assignment-shape parser):** Preserved as historical rationale for verifying
`window.<name> = <literal>` bodies structurally. The HTML parser recognises `<script>` tags without
a `type` attribute (or with `type="text/javascript"`) and hands their content to a JS-aware
extractor. The extractor identifies top-level assignment patterns (`window.VAR = expr`,
`var VAR = expr`) and extracts the assigned value as a JSON-parseable object for the same two-bucket
treatment as Case 8. The structural hash covers the assignment target (`window.__WIDGET_STATE__`);
the dynamic values inside the object literal are verified separately.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html

<div class="init-widget">
  <script>window.__WIDGET_STATE__ = {"count":42,"random":0.7382,"ts":"14:32:19"};</script>
  ...
</div>
```

The assignment target (`window.__WIDGET_STATE__`) is structural; the object literal values (`count`,
`random`, `ts`) are dynamic.

---

## Case 15 — Conditional elements in SSR partial

**Route:** `GET /partials/conditional` **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR) **Destination:** `""` (fetched by JS)

An SSR partial whose element count varies between requests based on server-side conditions. Some
elements are only rendered when a predicate is true — e.g., a "milestone" badge every Nth request,
or an alert row when a value falls below a threshold. Two independent boolean conditions produce up
to four distinct structural variants.

**Why this matters (content-integrity framing):** Conditional rendering is the norm, not the
exception. Auth state, feature flags, empty states, error banners, role-based UI — most real SSR
components produce structurally different HTML depending on server-side conditions. Under CSP-only
this is uncontroversial for execution safety: fetched partial → `innerHTML` inertness + host-CSP
carries it. But _content integrity_ is where conditional rendering hurts — an attacker who
compromises the origin can hide the alert row, flip the milestone badge, or invert a feature-flag
gate, and DappFence has no body-side check to catch it. Case 15 is where the "content integrity is a
non-goal" position has the most visible cost. If a specific route needs it, refactor the
variant-carrying data to a JSON island (Case 8 pattern) — the fixed container is byte-hashable and
the island body can be JSON-schema-verified.

**Integration (current):** Allowlist (same story as Cases 3, 4, 18). Execution safety via
host-document CSP + `innerHTML` parser inertness at consumption. No body-side verification.

**Integration (retired — variant enumeration and its cousins):** Preserved as historical rationale
for the design that would have caught structural tampering. Three approaches were considered:

1. **Variant enumeration** — Enumerable structures at build time, each with its own manifest entry.
   Verifier tries each known variant until one matches. Works for small counts of independent
   booleans (2 conditions → 4 variants, 3 → 8); breaks down combinatorially beyond that.
2. **Per-position optionality markers** — Manifest records that at structural position P an element
   may optionally appear with exactly structure S. Verifier checks "present or absent? If present,
   does it match?" Avoids enumeration but needs a richer manifest schema than Case 3.
3. **Merkle-style subtree hashing** — Subtrees hashed independently; conditional subtrees contribute
   a "present"/"absent" leaf to the root hash. Equivalent to enumeration expressed as a tree.

All three were part of the retired general-shape parser scope. Variant enumeration additionally
forced full response buffering — the variant couldn't be identified until the skeleton hash was
computed over the complete body, so streaming was defeated. That buffering cost was one of the
concrete reasons the retired design was rejected. Under the current CSP-only direction this cost
doesn't apply because there's no body verification to buffer for.

**Example responses:**

```html
<!-- count=3, random=17: both optional rows present -->
<dl class="cond-data">
    <div class="cond-row">
        <dt>Request #</dt>
        <dd>3</dd>
    </div>
    <div class="cond-row milestone-row">
        <dt>Milestone</dt>
        <dd>every third request</dd>
    </div>
    <div class="cond-row alert-row">
        <dt>Alert</dt>
        <dd>low value (random &lt; 30)</dd>
    </div>
    <div class="cond-row">
        <dt>Random</dt>
        <dd>17</dd>
    </div>
</dl>

<!-- count=4, random=55: neither optional row present -->
<dl class="cond-data">
    <div class="cond-row">
        <dt>Request #</dt>
        <dd>4</dd>
    </div>
    <div class="cond-row">
        <dt>Random</dt>
        <dd>55</dd>
    </div>
</dl>
```

Two independent boolean conditions → up to four structural variants. A single skeleton hash cannot
cover this route; the manifest needs one entry per reachable variant, or a schema that can express
per-position optionality.

---

## Case 16 — Static asset loading

**Route:** `GET /static-demo.js` **Frameworks:** Astro + Next.js **Render time:** Build time (static
file, never changes) **Destination:** `"script"` (loaded via `<script src>`)

A static JavaScript file served from the `public/` directory. Unlike the partials in Cases 1–5 which
are fetched by JS with `destination: ""`, this file is loaded by the browser as a script —
`destination: "script"`.

**Verification:** Same as Case 1 — full SHA-256 hash recorded in the manifest at build time. The new
dimension is the interception point: DappFence must intercept `destination: "script"` requests in
addition to `destination: ""` and `destination: "document"`. The hash comparison logic is identical;
only the fetch event filter differs.

This is the primary DappFence guarantee. JS bundles are the highest-value attack target — an
attacker who tampers with `main.js` can do arbitrary damage on any page that loads it. CSP-based
mechanisms allowlist the URL but do not verify the bytes at that URL; only the SW's per-response
hash check catches asset-byte tampering.

**Integration (current):** The integration hashes the static file at build time and writes the hash
into `manifest.files`. The service worker's fetch event handler includes `destination: "script"` in
its intercept filter alongside `""` and `"document"`.

**Example response:**

```http
GET /static-demo.js

HTTP/1.1 200 OK
Content-Type: application/javascript

export const DEMO_VERSION = "1.0.0";
export function hello() { return "Hello from static-demo.js"; }
```

---

## Case 17 — Non-enumerable dynamic path parameters

**Route:** `GET /api/item/:id` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `""` (called via `fetch()`)

A dynamic API route where the path parameter `:id` can be any value — not from a finite enumerable
set known at build time. Unlike Case 2 (parameterized static partial with `generateStaticParams`),
these IDs are runtime values (e.g. database primary keys, UUIDs) that cannot be pre-enumerated.

**Why Cases 1–2 do not apply:** Case 1 and 2 work because all valid IDs are known at build time and
each gets a hash entry in the manifest. For `GET /api/item/42`, `GET /api/item/99`,
`GET /api/item/some-uuid`, there is no finite list — any value could appear in the path. The
manifest cannot list them all.

**Integration (current):** Pattern-based allowlist. The integration writes
`{ "/api/item/:id": { type: "allowlist" } }` into the manifest; the SW matches requests against the
pattern and passes them through. Same story as Case 5 — no integrity check, only the URL pattern is
"trusted."

**When to prefer converting to Case 2:** if the set of valid IDs is actually finite and stable
(product catalog with a fixed SKU list, a static route table), list the IDs at build time via
`getStaticPaths` / `generateStaticParams`. The route becomes Case 2 and each concrete URL gets a
byte hash. Only viable when the ID set is truly closed.

**Integration (retired — structure-only hash):** Preserved as historical rationale. If the response
body had a fixed schema across all IDs (same JSON keys every time, only leaf values differ),
skeleton/template hashing from Case 3 could have covered content integrity — one structural hash
across every response, dynamic values checked heuristically. Tied to the retired general-shape
parser; not on the roadmap. Under the current direction the allowlist is the answer, and content
integrity for the response body is a non-goal.

**Example response:**

```http
GET /api/item/42

HTTP/1.1 200 OK
Content-Type: application/json

{"id":"42","name":"Item 42","updatedAt":"2026-06-23T14:32:17.000Z"}
```

The response structure is fixed (`id`, `name`, `updatedAt`) but the values are runtime-determined. A
pattern allowlist treats this route as unverified; skeleton hashing would verify the structure only.

---

## Case 18 — Variable-length list (unbounded structural variants)

**Route:** `GET /partials/variable-list` **Frameworks:** Astro + Next.js **Render time:** Request
time (SSR) **Destination:** `""` (fetched by JS)

An SSR partial that renders a list of N items where N is data-driven — it comes from the DB module
and changes every request. Unlike Case 15 where a boolean condition toggles one optional element,
here the number of `<li>` elements is unbounded. N=0 through N=6 in this demo; in a real application
N is a row count, search result count, or pagination size — effectively infinite.

**Why this matters (content-integrity framing):** every fetched partial in the catalog sits behind
the same execution-safety composition — `<script>` inside `innerHTML` is inert (browser parser rule)
and every other vector (`<img onerror>`, `<a href="javascript:">`, `<iframe src=javascript:>`) is
gated by the host page's DappFence CSP. Case 18 inherits that same guarantee. What Case 18 uniquely
loses is **content integrity**: an attacker who compromises the origin can alter list contents
(wrong prices, phishing text, spoofed row counts), and DappFence has no response-body hash to catch
it. Content integrity for fetched partials is a stated non-goal; Case 18 is where that non-goal has
the most practical bite.

**Integration (current):** Allowlist — the manifest records
`{ "/partials/variable-list": { type: "allowlist" } }`. Execution safety is delivered by
host-document CSP + `innerHTML` parser inertness. If content integrity matters for a specific route,
refactor it to render a fixed container plus a `<script type="application/json">` data island
holding the list items (Case 8 pattern); the fixed container is byte-hashable and the data island
can be structurally verified via JSON extractor.

**Integration (retired — no viable design):** Preserved as historical rationale. Under the retired
skeleton-hashing design, Case 18 was called out as the hard limit for body verification because no
fixed skeleton covers variable N (each distinct N is a structurally different response), and variant
enumeration hits the same wall for unbounded pagination. Under CSP-only there's no body verification
to try, so the "hard limit" framing no longer applies — Case 18 is representative of the
fetched-partial family, not exceptional.

**Example responses:**

```http
GET /partials/variable-list   (request #1 → 1 item)

HTTP/1.1 200 OK
Content-Type: text/html

<div class="var-list">
  <header class="var-header"><span>Showing 1 item</span><span>request #1</span></header>
  <ul class="var-items">
    <li class="var-item"><span>#1</span><span>73</span></li>
  </ul>
</div>
```

```http
GET /partials/variable-list   (request #3 → 3 items)

HTTP/1.1 200 OK
Content-Type: text/html

<div class="var-list">
  <header class="var-header"><span>Showing 3 items</span><span>request #3</span></header>
  <ul class="var-items">
    <li class="var-item"><span>#1</span><span>73</span></li>
    <li class="var-item"><span>#2</span><span>36</span></li>
    <li class="var-item"><span>#3</span><span>24</span></li>
  </ul>
</div>
```

Different number of `<li>` elements — structurally incompatible responses from the same URL.
Skeleton hashing and variant enumeration both fail as body-verification strategies; the current
direction (CSP + innerHTML inertness) sidesteps the problem entirely at the cost of no
content-integrity guarantee.

---

## Case 19 — Parameterized SSR navigation without `getStaticPaths`

**Route:** `GET /partials/dynamic/[id]` **Frameworks:** Astro + Next.js **Render time:** Request
time (SSR) **Destination:** `"document"` (full page navigation)

A full HTML page with non-enumerable path parameters. The IDs are runtime values — they cannot be
pre-enumerated at build time.

> **Integration note (2026-06-25).** The "What happens" description below assumes the retired
> streaming rewriter (SW matches each inline against a manifest skeleton for the route pattern).
> Under the current CSP-only direction, inline script handling on this route collapses to: the SW
> emits `script-src-elem 'nonce-N' *` and tags only its own bootstrap with N. Any build-time-stable
> inline whose SHA-256 is listed in `csp.pages[patternKey].scripts` can also run (the SW emits the
> hash alongside the nonce). Everything else (including per-page-instance inline like
> `initReport("report-42")` in the example) is blocked by the browser. The developer options at the
> bottom of this case still hold, but option 3 (`getStaticPaths` → Case 2) no longer has the
> subtlety about "route-pattern skeletons" — it's simply "if it's not a byte-hashable inline, it
> needs to be an external script or a data island." Retained prose describes the retired mechanism
> for historical rationale.

**What happens (retired streaming-rewriter design):**

DappFence's SW streams the response through the parser and rewriter. For inline scripts on this
route, the SW checks each script against the manifest's skeleton for the route pattern
`/partials/dynamic/[id]`. If the manifest declares a build-time-stable inline script (theme
bootstrapper, framework init) whose body matches, the SW writes `nonce=N` and it executes. If a
script's body doesn't match anything in the manifest, no nonce is written and the browser blocks it.

For pages the developer has not registered in the manifest at all (no skeleton for the pattern),
inline scripts are blocked preemptively — no manifest entry means no verifiable script.

**Forcing function:**

This is intentional. An inline script on a page whose skeleton has not been declared in the manifest
is an unverifiable code execution vector. DappFence's response is: don't let it execute.

The developer has three options:

1. **Move the script to a `.js` file** — external scripts are byte-hash verified (Case 16); the
   inline script problem disappears.
2. **Remove the inline script** — if the script only initialises state from server data, use a
   `<script type="application/json">` data island (Case 20 pattern).
3. **Use `getStaticPaths`/`generateStaticParams`** — if the valid IDs are finite and known at build
   time, enumerate them and convert this to Case 2 (parameterized static).

**Comparison with Case 2:**

Case 2 (`/partials/[id]`) uses `getStaticPaths` / `generateStaticParams`, so the integration fetches
each concrete URL at build time and captures the skeleton for the route. Case 19 has no
`getStaticPaths` counterpart — the integration cannot enumerate the IDs, so the SW cannot verify
per-URL and inline scripts must fall back to route-pattern skeletons.

**Example response:**

```http
GET /partials/dynamic/report-42

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …
  ← injected by DappFence

<!DOCTYPE html><html lang="en">
<head>
  <!-- Theme bootstrapper: SW verifies against manifest skeleton for build-time-stable inline scripts;
       if match → writes nonce="<SW-N>"; if no match → no nonce → blocked. -->
  <script>(function(){var s=localStorage.getItem('theme');...})();</script>
</head>
<body>
  <h1>Dynamic · report-42</h1>
  <script>initReport("report-42");</script>  ← page-specific inline script; likely no manifest skeleton → blocked
</body>
</html>
```

Moving page-specific logic to a `.js` file resolves the page-specific script; the bootstrapper is
verifiable as long as it's registered in the route-pattern manifest entry.

---

## Case 20 — SSR navigation with per-request inline script data

**Route:** `GET /inline-data` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `"document"` (full page navigation)

A full HTML page with two data-passing patterns side by side:

1. **Executable inline script** — `<script>window.__serverTime = 1720879200123;</script>` The body
   contains `Date.now()` rendered at request time. Every millisecond produces a different body.

2. **JSON data island** — `<script type="application/json" id="__df_server_time">{…}</script>`
   `type="application/json"` makes this non-executable. The browser's CSP `script-src` directive
   does not apply to it at all — no verification is needed for the fact of its existence (though
   DappFence's structural skeleton still checks it's in the expected position).

> **Integration note (2026-06-25, updated 2026-08-19).**
>
> -   **Pattern A** (executable inline with per-request `window.__STATE__ = <literal>`) — **first
>     step incompatible; general-shape parser was retired.** The refactor is Pattern B. Any
>     per-shape parser for arbitrary assignment shapes was on the retired path and is not planned.
> -   **Pattern B** (JSON data island) — **current recommended primitive** for per-request data
>     delivery. The SW byte-hashes the island body where the manifest declares it, or references a
>     JSON schema. Client reads via `JSON.parse(getElementById(id).textContent)`.
> -   **Pattern C** (RSC push chunks) — **first step incompatible; RSC parser planned next.** Same
>     story as Case 6a. Apps hitting Pattern C today can drop `force-dynamic` (fall back to Pattern
>     B) or wait for the RSC parser to land.
>
> The "What happens under the streaming SW rewriter" prose below is retired for the general-shape
> case (Pattern A) and reflects the planned mechanism for Pattern C (RSC parser).

**What happens (retired streaming-rewriter design):**

For **Pattern A**, the SW parses the script body and applies the manifest's skeleton for a
`window.<name> = <value>` assignment shape (see Case 14). The assignment target is structural; the
value is a dynamic leaf with a heuristic (`integer`, `iso-timestamp`, etc.). If the parse matches
and the value passes the heuristic → SW writes `nonce=N` → browser executes. If the shape is
tampered (`window.__serverTime = fetch('/steal')` or `<script>evil()</script>`) → no manifest match
→ no nonce → blocked.

For **Pattern B** (JSON island), the SW verifies structural position (script tag with
`type="application/json"` and `id="__df_server_time"` at the expected place) and passes it through.
The browser doesn't execute it; the page's client code reads it via
`document.getElementById('__df_server_time').textContent`.

For **Pattern C — RSC push scripts** (Next.js App Router only): the SW routes each
`<script>self.__next_f.push(...)</script>` block to the RSC parser (see Cases 6–7). The RSC parser
walks the wire-format payload, verifies the tree structure against the manifest skeleton, and
applies dynamic-leaf heuristics to embedded data. If verified → `nonce=N` → hydration works.

The mechanism collapses all three patterns to the same rule: **parse against manifest skeleton,
verify structure and dynamic leaves via heuristics, apply nonce iff verified.** No special case for
RSC, no `dynamicRSC` fallback, no per-request build-time hash pre-computation.

**Why per-request inline scripts don't have build-time hashes:**

The prior design listed each inline script's SHA-256 in the CSP header at build time. That only
works if the script body is byte-for-byte identical on every response. Any per-request data in a
script body — including RSC payload chunks, per-request timestamps, embedded user IDs — breaks that
assumption and results in the browser blocking the script. With the streaming SW rewriter,
per-request scripts are verified against a _structural skeleton_ (declared once in the manifest)
rather than a _byte hash_ (which would have to be recomputed per request), so this class of failure
is closed.

**When JSON islands are still the right pattern:**

Even though the streaming SW rewriter can verify per-request executable inline scripts, JSON islands
remain the cleanest option for per-request data delivery:

-   No skeleton parser needed for the data itself (the SW only checks the island's positional
    structure; the data inside doesn't need heuristics).
-   Not executable → no attribute-XSS vectors even under future changes to CSP.
-   Framework-agnostic: readable via `getElementById().textContent` regardless of framework.

For per-request executable behaviors that _can't_ be moved to islands (framework hydration wire
formats like RSC), the skeleton-parse path is the only option — but wherever the developer has
choice, islands are simpler.

**Example response:**

```http
GET /inline-data

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …

<!-- Pattern A: SW verifies via window.<name> = <literal> skeleton, applies nonce -->
<script nonce="<SW-N>">window.__serverTime = 1720879200456;</script>

<!-- Pattern B: JSON island. Non-executable. SW checks positional structure only. -->
<script type="application/json" id="__df_server_time">
  { "serverTime": 1720879200456 }
</script>

<!-- Pattern C (Next.js App Router): SW routes each push to the RSC parser, applies nonce iff verified -->
<script nonce="<SW-N>">self.__next_f=[];</script>
<script nonce="<SW-N>">self.__next_f.push([0,"…layout tree…"]);</script>
<script nonce="<SW-N>">self.__next_f.push([1,"…page tree with serverTime…"]);</script>
```

---

## Case 21 — ISR page (revalidate)

**Route:** `GET /news` **Frameworks:** Next.js only **Render time:** Build time and periodic
regeneration (ISR, `export const revalidate = 60`) **Destination:** `"document"` (full page
navigation)

A Next.js App Router page that is pre-rendered at build time and cached, but regenerated in the
background every `revalidate` seconds when a new request arrives after the TTL expires.

> **Integration note (2026-06-25, updated 2026-08-19).** Same story as Case 6 and Case 20 Pattern C:
> RSC push scripts are per-request inline. **First step:** blocked under CSP-only. **Next step
> (planned RSC parser):** compatible — same mechanism as Case 6.
>
> The case's unique dimension is _manifest lifecycle_: byte hashes captured at build time silently
> go stale on ISR revalidation — a ticking-time-bomb failure mode that would not manifest until the
> next revalidation window. That lifecycle problem is real regardless of which body-verification
> mechanism the SW uses; the RSC-parser plan doesn't remove it, it just shifts the risk from "byte
> hash stale" to "skeleton drifted." The "What happens" prose below describes what verification
> would look like once the RSC parser lands.

**What DappFence captures at build time (planned — under the RSC parser):**

The integration renders the page at build time and records the manifest entry:

1. Route-pattern skeleton for the outer HTML.
2. Structural skeletons for expected inline scripts (layout bootstrapper as a build-time-stable
   body, RSC push script shapes with dynamic-leaf slots for headline/counter/timestamp data).

**What happens after ISR regeneration:**

The server re-renders the page at TTL expiry. Both the outer HTML body and the RSC push scripts
change (new headline text, new counters, new timestamps). Under the streaming SW rewriter:

-   The outer HTML is parsed against the route skeleton. Structural changes (extra elements, missing
    elements) would fail verification; leaf value changes (updated headline text) pass through as
    dynamic values.
-   Each RSC push script is parsed against the RSC skeleton. The tree structure is verified against
    the manifest; the dynamic leaves (headline, counter, timestamp) are extracted and
    heuristic-checked.
-   Verified scripts get `nonce=N`. Verified body pass-through. Hydration works.

**Relationship to Case 20:**

Case 20 and Case 21 have the same shape under the streaming rewriter — both need skeleton
verification of per-request inline scripts. Case 21's specifics are that the page is served from a
build-time cache initially and only regenerates on TTL expiry, so the manifest skeleton must be
robust to the range of headlines/counters/timestamps that ISR will produce.

**Example response (after ISR revalidation):**

```http
GET /news

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …

<!DOCTYPE html><html lang="en">
<head>
  <script nonce="<SW-N>">(function(){var s=localStorage.getItem('theme');…})();</script>
  ← build-time-stable bootstrapper; skeleton match → nonce applied
</head>
<body>
  …
  <script nonce="<SW-N>">self.__next_f=[];</script>
  <script nonce="<SW-N>">self.__next_f.push([0,"…layout tree…"]);</script>
  <script nonce="<SW-N>">self.__next_f.push([1,"…updated page tree…"]);</script>
  ← RSC push scripts with new dynamic content; SW verifies each against RSC skeleton
</body>
</html>
```

The layout bootstrapper (build-time-stable) and the RSC push scripts (verified against the RSC
skeleton at runtime) all get the SW-generated nonce. Body pass-through.

---

## Case 22 — Not-found response body

**Route:** `GET <unmatched>` **Frameworks:** Astro + Next.js **Render time:** Build (prerendered) or
per-request (SSR fallback) **Destination:** `"document"` (full page navigation)

The response body served by the framework when the request URL matches no route. Both frameworks
have file-based conventions for this — Astro `src/pages/404.astro`, Next.js `src/app/not-found.tsx`
— and both emit a full HTML page with hydration scripts, so the wire response is byte-shaped
identically to any other navigation and must be verifiable.

**Why the case exists:** the 404 response is a legitimate navigation outcome that ships executable
`<script>` tags (theme bootstrap, framework hydration, DappFence bootstrap). Without a manifest
entry the SW must either block the response (breaking the 404 UX) or pass it through unverified (a
tampering vector — the origin could swap the 404 body for a phishing page). The case exists so each
integration has an explicit policy for this path.

**Astro (implemented):** `src/pages/404.astro` declares `export const prerender = true`. Astro
writes `dist/client/404.html` at build. The `astro:build:done` disk walk hashes it into
`manifest.pay.files["/404"]` and the bootstrap `<script>` is injected there via the same disk-walk
`injectScriptTag` path used for every other prerendered page. The node adapter serves the file on
any unmatched route; the SW verifies the byte-hash on every 404 response.

**Next.js (unverified today):** `src/app/not-found.tsx` compiles to
`.next/server/app/_not-found.html`. `@dappfence/next`'s `hashPrerenderedPages` in `src/ssr.js`
explicitly skips files starting with `_` (to avoid hashing `_error`, `_document`, `_app` internals).
`_not-found.html` gets caught by this filter as well, so the 404 body is not in the manifest and the
SW has no entry to compare against. **Gap.** Fix options:

1. Narrow the underscore filter to `_error` / `_document` / `_app` only, include `_not-found.html`
   under the URL path `/404` (or a dedicated pathRule for the not-found body).
2. Add a `not-found` pathRule (analogous to the last-resort rule already used for verifying 404
   status codes in `@dappfence-core`) that names `_not-found.html` as the fallback body.

Under either option the 404 response becomes byte-verified like Case 1.

**Example response (Astro, verified):**

```http
GET /does-not-exist

HTTP/1.1 404 Not Found
Content-Type: text/html

<!DOCTYPE html><html lang="en">
<head>
  <script src="/dappfence.js" ...></script>  ← injected at build via disk walk
  ...
</head>
<body>...404 body...</body>
</html>
```

SW looks up `/404` in `manifest.pay.files`, byte-hash matches, pass-through.

---

## Case 23 — Error boundary response body

**Route:** any route that throws → 500 **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR error path) **Destination:** `"document"`

The response body served when a route throws an uncaught error. Framework conventions: Astro
`src/pages/500.astro` (in `output: 'server'` mode), Next.js `src/app/error.tsx` (a client component
acting as a segment-level React error boundary). Same wire shape as any SSR navigation: full HTML
with hydration scripts.

**Why the case exists:** error responses are per-request (the error message, stack digest, and
timestamp all vary) and cannot be byte-hashed. But they still ship executable inline scripts — theme
bootstrap, hydration, RSC `__next_f` push — so CSP must apply to the error body the same way it
applies to Case 9 (full SSR page). Without an integration path for this, a route that throws falls
through to a browser default or origin-controlled body with unbounded inline execution.

**Astro (implemented via middleware):** `src/pages/500.astro` declares `prerender = false`. In
`output: 'server'` mode, Astro renders it per request whenever an SSR error propagates. The
`@dappfence/astro` pre-order middleware runs on the error response (it's still `text/html`), injects
the bootstrap `<script>` into `<head>`, and — once CSP injection lands — will emit the SW-nonced CSP
header. Same mechanism as Case 9 applied to the error path.

**Next.js (implemented via runtime instrumentation):** `src/app/error.tsx` MUST declare
`'use client'` (Next requires client components at error boundaries). React renders it inside the
closest enclosing layout when a segment throws. The response is full HTML: layout shell + error
boundary markup + framework hydration (`__next_f` push) + DappFence bootstrap from
`getDappfenceScriptAttrs()` in the root layout. Because it's rendered per request, no on-disk
`.html` file exists and body-hash is not applicable. The `@dappfence/next/instrumentation` runtime
hook rewrites the RSC `__next_f` push scripts to inert JSON + a static reader script (see Case 6);
inline scripts in the error boundary body itself must be in `csp.pages` for the corresponding route
(or the error route pattern) or CSP blocks them. Same mechanism as Case 9 applied to the error path.

**Precondition:** the framework's error component must not embed per-request executable data
(timestamps, stack traces) inline. Error boundaries that need per-request data must use the
JSON-island pattern (Case 20 Pattern B) — an inert `<script type="application/json">` carrying the
error digest, consumed by client code.

**Example response (Next.js):**

```http
GET /throws

HTTP/1.1 500 Internal Server Error
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-<SW-N>' ...

<!DOCTYPE html><html lang="en">
<head>
  <script src="/dappfence.js" ...></script>
  <script nonce="<SW-N>">(function(){var s=localStorage.getItem('theme');...})();</script>
  ← theme bootstrap; build-time-stable, hashed into csp.pages
</head>
<body>
  <div class="error-boundary">...error UI, rendered by error.tsx...</div>
  <script type="application/json" data-nfp>{...}</script>
  ← RSC __next_f rewritten to inert JSON (via instrumentation.ts)
  <script nonce="<SW-N>">(reader init — one hash, static, in csp.pages)</script>
</body>
</html>
```

The SW strips the origin CSP, applies its own SW-nonced CSP, and nonces the build-time-stable
scripts whose hashes are in `csp.pages`. The error UI itself is a Case 9 body (CSP-only, no byte
hash) rendered inside the enclosing layout.

**Sharp edge:** neither framework's error path is naturally exercised by a green build. Add a
purpose-built trigger route (Astro `src/pages/throws.astro` throwing in the frontmatter, Next.js
`src/app/throws/page.tsx` throwing in render) so the case can be tested in CI.

---

## Case 24 — Auto-inferred dynamic

**Route:** `GET /partials/inferred` **Frameworks:** Next.js only **Render time:** Request time
(inference-driven) **Destination:** `""` (fetched by JS)

A Next.js Route Handler with no `export const dynamic = ...` at the top. The handler calls a dynamic
API — `headers()` in the fixture — which flips Next's per-render dynamic-inference flag at runtime.
Observable render behaviour is identical to `dynamic = 'force-dynamic'`; this case exists to prove
that DappFence's build-time route classification handles inferred dynamism the same way as declared
dynamism.

**Astro parallel:** none. Astro's `output: 'server'` renders every route dynamically by default;
prerender opt-in is declarative (`export const prerender = true`). There is no runtime API that
"promotes" a page from prerendered to SSR after the config is read. The Next-only asymmetry is that
Next's `dynamic = 'auto'` is a soft policy that flips on API usage, while Astro's mode is locked at
build.

**Verification:** identical to Case 3. The `@dappfence/next` CLI reads `.next/routes-manifest.json`
and `.next/server/app-paths-manifest.json` after `next build`; any App Router page or Route Handler
that is not in the prerender manifest is classified as dynamic. That classifier does not inspect the
source for `dynamic` exports — it only reads what Next itself produced. So a route that reached
dynamic status via `headers()` (or `cookies()`, `searchParams`, uncached `fetch`, etc.) shows up in
the classifier exactly like a route with `dynamic = 'force-dynamic'`: entry in `csp.pages` with
empty `{ scripts: [], attrs: [] }`, `contentRules` gets an `action: 'csp'` for its prefix, no body
hash.

**Precondition:** the dynamic-inference trigger must actually fire during `next build`'s prerender
pass. If the API is called inside a `try/catch` that swallows the `DynamicServerError`, or behind a
runtime condition that skips the call at build time, Next may attempt to prerender the route and
produce an on-disk HTML → the CLI hashes it and treats it as static. This is a Next-side gotcha, not
a DappFence concern: match the framework's expectation.

**Example manifest entry (identical to Case 3):**

```json
{
    "csp": {
        "pages": {
            "/partials/inferred": { "scripts": [], "attrs": [] }
        }
    },
    "contentRules": [
        {
            "condition": { "resourceTypes": ["document"], "urlFilter": "/partials/inferred" },
            "action": { "type": "csp" }
        }
    ]
}
```

No entry in `manifest.pay.files["/partials/inferred"]`. SW enforces CSP with empty script hashes; no
per-request body verification.

---

## Composition: what host-page CSP catches for injected content

DappFence's SW is a per-response mechanism. Once a response's bytes have been verified and
delivered, DappFence has no say over what the receiving document does with them. If the document
does `container.innerHTML = fetchedBody` — or React's `dangerouslySetInnerHTML` equivalent — the
fetched HTML becomes part of the host document's DOM. From that point, **only the host document's
CSP governs runtime behavior of the injected nodes.**

### The innerHTML behavior matrix

| Injected node                       | Runtime behavior                            | Which CSP directive gates it              |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------- |
| `<script>…</script>`                | Doesn't execute (HTML parser rule, not CSP) | (parser rule; CSP not consulted)          |
| `<script src="…">`                  | Doesn't execute either (parser rule)        | (parser rule)                             |
| Manually cloned `<script>` appended | Executes                                    | `script-src`                              |
| `<img src="x" onerror="…">`         | onerror fires on load failure               | `script-src-attr` (blocked by `'none'`)   |
| `<img src="/foo.png">`              | Fetches image                               | `img-src`                                 |
| `<link rel="stylesheet" href="…">`  | Fetches CSS                                 | `style-src`                               |
| `<iframe src="…">`                  | Loads frame                                 | `frame-src`                               |
| `<a href="javascript:…">` clicked   | Runs                                        | `script-src 'unsafe-inline'` / disallowed |

### The design rule

**A page that fetches and injects HTML content must have CSP injected**, even if the page itself is
byte-hashed. Byte-hashing the page validates its bytes; it says nothing about what those bytes then
splice into the DOM at runtime.

Under the streaming SW rewriter, this is automatic: every navigation response gets a CSP header
generated by the SW. The composition gap that would exist under a "byte-hash pages skip CSP" design
never opens.

---

## The trust model and what it forces

Every previous section has quietly relied on a specific trust boundary and a specific scope of a
guarantee. This section spells both out and traces what they force on the design.

### Scope of a guarantee

DappFence's guarantee is **no attacker-controlled JavaScript executes in the browser under this
origin**. Nothing more.

Explicitly _out_ of scope:

-   **Content integrity of dynamic response data.** If a Case 3 dynamic leaf holds an integer, an
    attacker with server control can change the integer. DappFence doesn't check that the integer is
    "correct".
-   **Phishing via attacker-controlled link destinations.** If a dynamic `href` leaf can hold a URL,
    an attacker can point it at a phishing site. As long as clicking the link doesn't execute
    JavaScript, this is out of scope.
-   **Tracking beacons, image-based data exfil, visual misinformation.** These are user-harm
    categories DappFence intentionally does not address.
-   **User confusion from swapped visible text.** Same reason.

The single promise is execution containment. Everything else is either the job of a different layer
in the stack (WAF, honest content pipeline upstream) or a knowingly accepted residual risk.

### The trust boundary

| Component                                            | Trusted at runtime? | Why                                                                          |
| ---------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| DappFence SW + runtime bundle                        | Yes                 | Delivered/pinned by the extension, hash-verified against dev-signed identity |
| Manifest (asset hashes, skeleton hashes, CSP tokens) | Yes                 | Signed at build time with a secp256k1 key held offline                       |
| Any URL/hash _listed inside_ the signed manifest     | Yes                 | Signature covers them                                                        |
| Origin server _at runtime_                           | **No**              | Assumed compromised                                                          |
| Any header the origin emits                          | **No**              | Attacker rewrites                                                            |
| Any nonce the origin generates                       | **No**              | Attacker mints their own with matching CSP                                   |
| Any inline `<script>` the origin serves              | **No**              | Attacker attaches the same "legitimate" markers to malicious payload         |

The dev-signed manifest is the sole runtime source of truth. Everything else must be derivable from
it, or actively verified against it.

### What this trust boundary forces us to discard

-   **Origin-emitted nonces are useless.** The origin generates them, and the compromised origin
    mints identical nonces for injected scripts. Same CSP, same nonce, attacker wins. **DappFence
    must generate its own nonce per response and must never propagate origin-emitted nonces into its
    injected CSP.**
-   **`strict-dynamic` is useless as a general-purpose escape.** Its trust chain roots at a nonced
    or hashed "trusted" script — and that script's trust would either come from an origin-generated
    nonce (defeated as above) or from a build-time hash that has to be byte-stable across all
    requests (which returns us to the same "no per-request inlines" constraint we already have).
-   **Origin-emitted CSP headers are meaningless.** The SW must inject the CSP itself, deriving
    directives from the signed manifest. Any CSP header the origin adds is stripped or ignored.

### What survives the trust boundary

1. **Byte hashing for assets.** The SW compares response bytes to the signed hash. The origin can't
   forge. Applies to JS bundles, CSS, images, static partials — the highest-value guarantee
   DappFence provides.
2. **Skeleton hashing for structural fidelity of dynamic content.** The SW verifies structure
   against a signed skeleton — element types, attribute names, positions. Dynamic leaves (text
   nodes, dynamic attribute values) are extracted and passed through unchecked; heuristics on those
   leaves exist only to distinguish "this is where the dynamic value lives" from "something
   structural has moved here". DappFence does _not_ attest to the content of a dynamic leaf.
3. **SW-injected CSP with SW-generated nonce.** The CSP is written by the SW, derived entirely from
   the signed manifest:
    ```
    script-src 'nonce-<SW-generated per response>' ;
    script-src-attr 'none';
    object-src 'none';
    base-uri 'none';
    frame-ancestors 'self';
    default-src 'self' <manifest-listed origins>;
    ```
    Every allowlist entry is signed. The nonce is generated by trusted SW code. No trust extended to
    the origin at runtime.
4. **Streaming SW parse + verify + rewrite.** For every navigation response, the SW streams the body
   through an HTML parser + verifier + nonce-rewriter. Each inline `<script>` is verified against
   its manifest skeleton (byte-exact for build-time-stable scripts; structural and heuristic for
   per-request scripts like RSC pushes); on success, the SW writes the SW-generated nonce to the
   element. This is one mechanism, applied uniformly, covering static, buffered SSR, and streaming
   SSR/RSC alike.

### The hard consequence: per-request inline scripts need deep parsers

**Under this trust model, DappFence can only allow a per-request inline script to execute if it can
verify the script's content against a signed skeleton.** The choice is not "block or allow" — it's
"verify or block".

For build-time-stable inline scripts (developer-authored theme bootstrappers, framework initializers
with fixed bodies), verification is a byte-exact skeleton match — inexpensive. For per-request
inline scripts (RSC push chunks, Astro server-island init scripts, per-request `window.__STATE__`
assignments), verification requires a parser that understands the framework's wire format:

| Framework mechanism                                     | Requires which parser?                              |
| ------------------------------------------------------- | --------------------------------------------------- |
| Static / build-time-stable inline scripts               | Byte-exact skeleton match                           |
| `window.<name> = <literal>` assignments (Case 14)       | JS-assignment parser                                |
| `<script type="application/json">` islands (Case 8, 20) | Positional structural check only                    |
| Astro server-island init script (Case 10)               | Init-call parser (extract island URL + prop hash)   |
| Next.js RSC push scripts (Cases 6, 7, 20, 21)           | RSC Flight-protocol parser + tree skeleton verifier |

Parser depth is the actual security. A shallow shape check ("does this script start with
`self.__next_f.push`") is not enough — an attacker can craft a matching shape with a malicious
payload. A deep parse that walks the RSC tree, verifies structure against a signed skeleton, and
heuristic-checks dynamic leaves constrains the attacker to at most the dynamic-leaf surface (same as
Case 3).

### Why there's no CSP knob that allows RSC while blocking `javascript:` URLs

A tempting question: can we set `script-src` loosely enough to allow the framework's per-request
inline scripts, yet still block `<a href="javascript:…">` and similar execution-through-navigation
vectors?

The answer is no, cleanly, and the reason is baked into CSP's design.

| `script-src` config                         | RSC inline scripts                          | `javascript:` URLs                                                                        | Inline event handlers                 |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `'sha256-<build-time>'` (hashes only)       | Blocked                                     | Blocked                                                                                   | Blocked                               |
| `'sha256-…' 'nonce-XYZ' 'strict-dynamic'`   | Would work — but nonce from origin defeated | Blocked                                                                                   | Blocked                               |
| `'unsafe-inline'`                           | Works                                       | **Allowed**                                                                               | Allowed                               |
| Split via `script-src-elem 'unsafe-inline'` | Works                                       | **Allowed** (spec bundles `javascript:` URLs with inline `<script>` under this directive) | Blocked (if `script-src-attr 'none'`) |
| `'nonce-<SW-N>'` + SW parses/rewrites       | Works                                       | Blocked                                                                                   | Blocked                               |

Only the last row — SW-generated nonce + streaming parse-and-verify — actually solves the problem.
`'unsafe-inline'` in `script-src` (or `script-src-elem`) covers both inline scripts and
`javascript:` URLs together, because both are "inline script evaluation" from the browser's
CSP-enforcement perspective. No CSP token distinguishes them.

### The escape hatch: JSON data islands (still useful where possible)

Per-request data can cross the origin→browser boundary without ever being executable if it's carried
in `<script type="application/json">` blocks rather than executable inline scripts. Because
`type="application/json"` isn't executed by any browser, CSP `script-src` doesn't apply to it.
DappFence's role is only to verify (via structural skeleton) that the island exists at the expected
position. The client runtime reads the island via `document.getElementById(id).textContent`.

Case 20 documents this exact pattern for per-request timestamps. It remains the cleanest option
wherever the developer has a choice, because it removes the need for a wire-format parser entirely.
For framework-mandated wire formats like RSC push, the parser is unavoidable, but developer-authored
per-request data should default to islands.

### Realistic framework compatibility

| Framework mode                             | DappFence compatibility                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| Astro fully static (`output: 'static'`)    | Fully compatible; only build-time-stable inline scripts |
| Astro SSR/hybrid without server islands    | Compatible with SW skeleton parser                      |
| Astro server islands (Case 10)             | Compatible; requires Astro init-script parser in SW     |
| Next.js Pages Router with `getStaticProps` | Compatible; JSON island (`__NEXT_DATA__`) natively      |
| Next.js App Router with RSC                | Compatible; requires RSC Flight-protocol parser in SW   |

### The clear path, restated

**One primary mechanism per resource shape** — no overlap, no dual modes:

-   **Assets** (`.js`, `.css`, images, fonts, static partials): **byte hash**. CSP allowlists URLs
    but does not verify the bytes returned at those URLs. Only the SW's SHA-256 check on the fetched
    body catches asset tampering. Highest-value guarantee.
-   **Documents (navigation responses)**: **SW streaming parse + skeleton verify + nonce rewrite.**
    Regardless of streaming shape (static, SSR, RSC Suspense), one mechanism. CSP is committed at
    response start with the SW-generated nonce; body streams through the SW parser; each verified
    script gets the nonce; unverified scripts don't. Composition gap is closed because CSP is always
    present.
-   **Fetched HTML fragments (partials)**: **skeleton hash if dynamic, byte hash if static.**
    Runtime containment of what gets `innerHTML`'d is the host document's CSP, delivered by the
    document-side mechanism above.
-   **Per-request data best practices**: prefer JSON data islands where the framework doesn't force
    an executable wire format. Where it does (RSC), the SW's parser is the necessary work.

**Bottom line: streaming SW parse + verify + nonce is the universal mechanism for documents.**
There's no "buffered mode vs. streaming mode" branch. Every navigation response flows through the
same code path. The mental model is uniform: byte-hash assets, streaming-verify documents.

The cost — a per-framework wire-format parser and skeleton-declaration in the manifest — is real,
bounded (a handful of frameworks), and the honest ceiling of what a signed-at-dev-time integrity
system can offer against a compromised runtime origin.

---

## Cross-case subtleties

Comparisons and patterns that only become clear once all 21 cases have been read. Written as a
lookup rather than a linear read.

### Case 3 vs. Case 15 vs. Case 18 — same client, different verifier (retired distinction)

All `fetch + innerHTML`, all SSR partials. **Client-indistinguishable** — the developer writes the
same three lines of code for all three. Under the abandoned skeleton-hashing design these three
cases split by structural shape:

-   **Case 3** — fixed skeleton, varying leaves → single skeleton hash works.
-   **Case 15** — varying skeleton via boolean conditions → variant enumeration / per-position
    optionality / Merkle subtree hashing.
-   **Case 18** — unbounded N children → structural verification impossible; allowlist or redesign
    as Case 8.

**Under the current CSP-only direction, this distinction goes away.** None of the three get
response-body verification; all three rely on host-document CSP + `innerHTML` parser inertness for
execution safety. The verifier sees the same allowlist entry for each. What still differs is
content-integrity: Case 3 could be byte-hashed if desired, Case 15 could list its bounded variants,
Case 18 cannot be pinned body-side at all.

### Case 8 vs. Case 20 Pattern B — same mechanism, different delivery timing

Both use `<script type="application/json">` data islands. Both read via
`JSON.parse(getElementById(...).textContent)`. **Same mechanism, different delivery timing.**

-   **Case 8**: island is inside a fetched HTML partial. Client does `fetch + innerHTML` first, then
    `JSON.parse`. Two round-trips (nav + partial fetch).
-   **Case 20 Pattern B**: island is inside the initial SSR page doc. Browser already parsed the
    doc; no client fetch needed. One round-trip (nav only).

### Case 14 vs. Case 8 / Case 20B — executable-JS vs. inert-data transport

Both are "get server data to client JS." Different mechanisms:

-   **Case 14**: executable `<script>window.VAR = {…}</script>` (no `type`). Governed by
    `script-src`. Runs at doc parse if it's in an SSR page (Case 20 Pattern A shape). In this repo's
    Case 14 demo it's innerHTML-consumed and stays inert.
-   **Case 8 / 20B**: inert `<script type="application/json">`. CSP-exempt (`type` not in executable
    MIME list). Sits in DOM as inert data.

Case 14's demo uses partial-innerHTML consumption which inerts the script; production shapes
(`__NEXT_DATA__`, `__INITIAL_STATE__`) put it in SSR page context where it _does_ execute at doc
parse.

### Case 20 Pattern A vs. Case 14 — same syntax, different transport

Syntactically identical: `<script>window.VAR = <literal>;</script>`. Semantically identical too:
same skeleton, same verification, same heuristic checks on leaves.

Only difference: **transport.** Case 14 is inside an innerHTML-consumed partial (inert). Case 20A is
inside an SSR page doc (executes). Case 14's structural-verification vectors apply verbatim to Case
20A.

### Cases 6/7/11 — the RSC family

Client developer writes ~nothing to consume these. React's runtime does everything. Server-side
shape is what matters; DappFence's whole RSC-parser story is verifying the _response_, not
intervening in the client. Same for Case 10 (Astro islands): framework-auto-emitted init script does
the fetch/swap; developer writes only the island component.

### Cases 9/19/20/21 — the SSR-navigation family

Response _is_ the document. No innerHTML shielding. Inline scripts execute at doc parse unless CSP
blocks. DappFence's SW-injected CSP + skeleton verification are the only things between origin bytes
and script execution.

Contrast with all `fetch + innerHTML` cases where parser inertness alone would shield injected
`<script>` even if CSP failed. The nav family has no such backstop; CSP is doing the whole job.

### Layers of execution safety per case

DappFence's execution-safety composition depends on the case's consumption pattern:

1. **Response-side inspection** (byte hash of static bodies, JSON extractor on data islands, RSC
   parser on RSC push chunks) — rejects tampered bytes before they reach the client. Available for
   any body the manifest can pin: build-time-stable responses, JSON islands with declared schemas,
   RSC flight payloads with declared shapes.
2. **Host-document CSP** (DappFence SW-injected) + **`innerHTML` parser inertness** — blocks every
   execution vector inside a fetched fragment: inline `<script>`, `<img onerror>`, `javascript:`
   URLs, inline event handlers, inline `<style>` with legacy JS-execution syntax.

For **`fetch + innerHTML` cases (1, 2, 3, 4, 8, 13, 14, 15, 18)**, layer 2 is the primary
execution-safety layer. Skeleton hashing was originally designed to add a layer-1 body inspection
for the per-request-body subset (3, 4, 8, 15); that design is retired, so all fetched partials rely
on layer 2 for execution safety. Layer 1 remains where the body is byte-hashable (Cases 1, 2, 14):
it protects **content integrity**, not execution — layer 2 already protects execution regardless.

For **SSR-navigation cases (9, 19, 20, 21)** the response _is_ the document; there is no `innerHTML`
shield. Host-document CSP + a per-response SW-generated nonce are doing the whole job. Data islands
(`<script type="application/json">`) are inert data blocks CSP doesn't gate; the SW byte-hashes
their bodies where the manifest declares them.

**Case 18 stopped being the composition outlier** when skeleton hashing was retired. Under the
retired design it was the one route where layer 1 could not be built at all. Under the current
direction, layer 1 is missing for every per-request fetched body — Case 18 is representative, not
exceptional. What Case 18 uniquely loses is content integrity (unbounded list contents are not
verifiable body-side), which is a stated non-goal.

**Sensitivity to consumer choice** still stands as a caution across all `fetch + innerHTML` cases:
if a developer replaces `innerHTML` with `document.write(text)` or `DOMParser + append`, the parser
inertness half of layer 2 disappears. `document.write` executes `<script>` tags; `DOMParser`'s
result plus manual `append` can too, depending on cloning path. The `innerHTML` promise is doing
real work in this composition, and swapping consumers weakens the guarantee.

### The "hitchhiker data" pattern (Cases 20 and 21)

No client fetch. Data rides in the initial navigation response. Client code reads globals or parses
inert data islands. **Only cases in the catalog where "data comes with the page, no fetch" is the
intended developer pattern.**

Every other data-carrying case has an explicit fetch:

-   Developer-authored: Cases 1–4, 5, 8, 13, 14, 15, 17, 18.
-   Framework runtime: Cases 6/7 (React RSC), 10 (Astro islands), 11 (Next Server Actions).

Case 9 is a nav case but doesn't have per-request data intended for client consumption. Case 19
forces the developer to _avoid_ per-request inline data on unregistered routes.

Case 21 is Case 20 + a temporal dimension. On the client side both look identical; what's new in
Case 21 is the _manifest-lifecycle_ problem — hash-in-CSP fails not because bytes always vary
(Case 20) but because they occasionally vary on a schedule the developer doesn't control at request
time.

### Design-option-driven consumption-pattern shifts

For some cases the design options _change the client-consumption pattern_, not just the server —
side verification approach:

-   **Case 18** has three options: (1) allowlist [baseline; keeps `fetch + innerHTML`], (2)
    **redesign as fixed shell + JSON island** [shifts to `fetch + innerHTML + JSON.parse`,
    converging with Case 8's client pattern], (3) verify-the-code [keeps `fetch + innerHTML`, shifts
    trust to a different manifest entry]. The chosen approach reshapes what the developer writes on
    the client.
-   **Case 17** has three options that all preserve `fetch + .json()` client-side — only the
    server-side manifest schema changes.
-   **Case 19's forcing function**: the doc explicitly directs the developer to _rewrite_
    page-specific inline scripts as external `.js` (moves to Case 16) or as JSON islands (moves to
    Cases 8/20B). DappFence's inability to verify per-URL inline scripts _forces_ a client-pattern
    change on the developer.

Some cases are stable on the client no matter what DappFence does server-side; others (18, 19) tell
the developer to change what they write.

---

## Verification limits

This section synthesizes where DappFence's guarantees hold, degrade, and break entirely.

### Runtime CSP with SW-generated nonce and streaming verification

Every navigation response receives a
`Content-Security-Policy: script-src 'nonce-<SW-N>' ; script-src-attr 'none' ; …` header injected by
the SW. Each inline `<script>` element is verified against the manifest's skeleton for that route as
it streams through the SW; verified elements receive `nonce="<SW-N>"` and execute; unverified
elements are silently blocked. This closes both the "attacker injects new `<script>`" and the
"attacker tampers with existing `<script>`" attack vectors uniformly — no reliance on hash
pre-computation or origin cooperation.

### Strong guarantee — static assets (Cases 1, 2, 16)

Response bytes never change between requests. A full SHA-256 hash is both necessary and sufficient.
Any modification to bytes in flight is detected. This is also the most important guarantee in
practice: JS bundles and CSS are the primary attack surface for CDN-level tampering. An attacker who
modifies `main.js` can do arbitrary damage; an attacker limited to modifying rendered HTML is far
more constrained.

### Conditional guarantee — fixed-skeleton SSR (Cases 3, 4, 8, 9)

Skeleton hashing works when the HTML structure is identical on every request — only leaf text nodes
and known-dynamic attribute values differ. In practice, truly fixed-skeleton SSR routes are
uncommon. Most components have at least one conditional element, which means Case 15 applies.

### Degrading guarantee — bounded conditional structure (Case 15)

Variant enumeration works for a small, bounded set of possible structures (2–3 independent boolean
conditions → 4–8 variants). Costs:

-   Full response buffering required for the enumeration path — cannot stream-verify unless the
    server emits a variant marker on the root element.
-   Build-time tooling must trigger every variant to record its skeleton hash.
-   Combinatorial explosion: five boolean conditions → 32 variants; non-boolean branching →
    unbounded.

### No guarantee — unbounded structural variants (Case 18)

When element count is data-driven, skeleton hashing and variant enumeration both fail. Allowlist (or
restructuring to a JSON island) is the only option at the response-body level.

### The code-layer fallback

For routes that are not structurally verifiable at the response-body level, the meaningful guarantee
shifts: **verify the code that generates the response, not the response itself.**

If the JS bundles and server templates are verified (Cases 1/2/16), the server is running known-good
code. A CDN can tamper with bytes in flight, but it cannot change which code the origin executes.
For highly dynamic SSR, this is a stronger and more tractable guarantee than trying to hash the
rendered output.

The secondary protection: even if an attacker injects a `<script src="evil.js">` into a dynamic SSR
response body, that script file is not in the manifest — the SW will block it when the browser tries
to load it (Case 16). The injection succeeds at the HTML level but fails at the asset level.

### Threat model summary

| Attack vector                                          | DappFence response                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Tampered static JS/CSS bundle                          | Caught — Cases 1, 2, 16 (full hash)                                                                                    |
| New `<script>` injected into navigation response       | Caught — SW skeleton parser sees no match → no nonce → blocked                                                         |
| Inline script body altered on a navigation response    | Caught — skeleton parser sees structural or heuristic mismatch → no nonce                                              |
| New `<script>` tag injected into fixed-skeleton SSR    | Caught — Case 3 (skeleton hash, structural change)                                                                     |
| New `<script src="x">` injected into any SSR response  | Caught when `x` loads — Case 16 (asset not in manifest)                                                                |
| Parameterized SSR page with no manifest skeleton       | All inline scripts blocked preemptively — Case 19                                                                      |
| Per-request data in inline script                      | Verified via skeleton parser (Case 20) if structure known; unverifiable ones blocked                                   |
| ISR page regenerated after manifest build              | Verified via RSC skeleton parser on regenerated content — Case 21                                                      |
| `<script type="application/json">` tampered            | Not caught — CSP `script-src` does not govern data islands (structure verified only)                                   |
| Data values modified in SSR response                   | Not caught (not the primary threat; out of scope)                                                                      |
| Redirect hijacked to malicious destination             | Case 12 (Location header verification)                                                                                 |
| RSC wire format tampered                               | Caught — RSC Flight-protocol parser walks the tree (Cases 6, 7)                                                        |
| Nonce attribute value replaced                         | Not caught — value is excluded from hash by design; irrelevant because SW-injected CSP doesn't reference origin nonces |
| `<img src=x onerror>` in fetched partial via innerHTML | Caught — host CSP's `script-src-attr 'none'` blocks the handler                                                        |
| `<a href="javascript:…">` clicked                      | Caught — `script-src` without `'unsafe-inline'` blocks the URL                                                         |
