# Verification cases

Each case illustrates a distinct class of HTTP response that DappFence must handle. Runnable
examples for every case live in the
[dappfence-examples](https://github.com/coinspect/dappfence-examples) repository.

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

The examples repo covers all interception points above. Most routes are HTML partials fetched by JS,
but `/dashboard` (Next.js) and the `/live` page are full page navigations, and Case 16 demonstrates
`destination: "script"` for static JS assets. The `/dashboard` RSC case is particularly interesting
because the same URL produces different responses depending on _how_ it is reached: a hard
navigation returns a full HTML document, while a client-side route change causes React to fetch the
RSC wire-format payload as a `destination: ""` request.

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
correct hash entry. No new capability beyond Case 1, but requires the manifest to enumerate all
known IDs.

**Integration (current):** The integration calls `getStaticPaths` / `generateStaticParams` to
enumerate all valid IDs, fetches each concrete path (`/partials/service-worker`, `/partials/sha256`,
…), hashes each response, and writes one entry per ID into `manifest.files`. Unknown IDs (not in the
list) are not in the manifest and will be blocked.

---

## Case 3 — SSR partial, fixed skeleton, dynamic data

**Route:** `GET /partials/ssr` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `""`

The HTML structure (element types, class names, attribute names) is identical across every request.
Only data values differ (a counter, a timestamp, a random number from the DB module).

**Precondition:** The HTML structure — element count, nesting, and attribute names — must be
identical on every request. Only leaf text node values and known-dynamic attribute values (e.g.
`datetime`, `href`) may differ. If any element can appear in one response but not another
(conditional rendering based on server state), the structural skeleton is not fixed and this case
does not apply. See **Case 15** for that scenario.

**Verification:** DappFence cannot hash the full response (bytes differ every request). The approach
is _skeleton/template hashing_: strip the dynamic leaf values, serialize the structural skeleton,
and hash that. DappFence would need to know which parts of the response are structural vs. dynamic.
This is a new capability — not supported today.

**Integration (planned):** An HTML parser processes the response as the server streams it. The
parser separates the document into two buckets:

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

**Verification:** DappFence faces the same buffering requirement. It must accumulate all chunks
before computing a hash. This is tractable — the service worker can buffer — but requires explicit
streaming support so DappFence does not attempt to hash a partial response. The skeleton hashing
problem from Case 3 also applies here (data values differ per request).

**Integration (planned):** Same HTML parser approach as Case 3. Because the parser is
streaming-native — it processes the document incrementally as chunks arrive — no full buffering is
required before verification begins. The parser accumulates structural tokens and extracted dynamic
parts chunk by chunk, and finalizes the hash once the stream closes.

The manifest entry is identical in shape to Case 3. The service worker does not need a special
streaming flag because the parser already handles partial input.

**Relationship to Case 3:** Same structural/dynamic split problem, plus the added complexity of a
chunked transport. A DappFence implementation that handles Case 3 must additionally buffer chunks
before it can apply skeleton hashing.

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

**Integration (planned):** The integration writes `{ "/api/counter": { type: "allowlist" } }` into
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

This case has two sub-scenarios depending on how the page is reached:

### 6a — Hard navigation (`destination: "document"`)

The browser navigates directly to `/dashboard`. Next.js renders the full HTML document server-side
and sends it as a standard HTTP response. The response is a complete HTML document, but it embeds
RSC payload in `<script>` tags that React uses to hydrate.

**Verification:** The HTML document changes per request (RSC payload is inlined). Same
structural/dynamic split problem as Case 3, but applied to a full page rather than a fragment.

**Integration (planned):** The HTML parser from Cases 3 and 4 applies to the outer HTML document.
However, the RSC payload is embedded inside `<script>` tags as a separate line-delimited format —
the HTML parser must recognize these blocks and hand them off to an RSC-specific parser rather than
treating their content as leaf text. The RSC parser then separates structural component tree nodes
from dynamic data values and applies the same heuristic verification to the extracted pieces.

**Note (Case 6a vs Case 14):** The `<script>self.__next_f.push([…])</script>` blocks are RSC
wire-format payloads handled by the RSC parser — not the JS-aware extractor from Case 14. The
distinction: RSC scripts carry a structured line-delimited component tree; Case 14 scripts carry a
`window.VAR = {…}` global assignment. The HTML parser identifies RSC blocks by the `self.__next_f`
pattern and routes them to the RSC parser rather than the JS extractor.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html

<!DOCTYPE html><html lang="en"><head>…</head><body>
<div id="__next">
  <h1>Dashboard</h1>
  <p class="counter">42</p>
</div>
<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>
<script>self.__next_f.push([0,["$","section",null,{"children":["$","p",null,{"children":42}]}]])</script>
<script>self.__next_f.push([0,{"timestamp":"2026-06-23T14:32:17.000Z"}])</script>
</body></html>
```

Both the visible HTML and the `<script>` RSC payloads contain dynamic values (counter, timestamp).

### 6b — Client-side navigation (`destination: ""`)

The user navigates to `/dashboard` via a `<Link>` click after the initial page load. React fetches
the RSC payload as a `fetch()` request. The response is **not HTML** — it is the RSC wire format: a
line-delimited mix of JSON references and HTML fragments.

**Verification:** The response is RSC wire format (line-delimited, mixing JSON references and HTML
fragments) — not HTML. The HTML parser from Cases 3 and 4 does not apply here.

**Integration (planned):** A dedicated RSC parser walks the wire format, separates structural
component tree nodes from dynamic leaf values, hashes the structure, and applies heuristic
verification to the extracted dynamic parts — the same two-bucket principle as the HTML parser, but
implemented for the RSC protocol. This is a larger lift because the RSC format must be understood at
the protocol level, not just as text.

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

**Route:** `GET /dashboard` (same page as Case 6, with Suspense boundaries) **Frameworks:** Next.js
only **Render time:** Request time, RSC chunks **Destination:** `"document"` on hard nav, `""` on
client-side nav

A continuation of Case 6. The `/dashboard` page wraps slow components in `<Suspense>`. React sends
an initial RSC shell immediately, then flushes additional RSC chunks as each Suspense boundary
resolves.

**Verification:** Same as Case 6b (RSC parser, two-bucket approach) with the added complexity that
the RSC payload arrives in multiple chunks as Suspense boundaries resolve. The RSC parser must
handle incremental input — the same streaming-native property the HTML parser has for Cases 3 and 4.
RSC chunks may arrive out of order, so the parser must also reassemble the component tree before
finalising the structural hash.

This is the hardest verification case in the plan and is included to establish the upper bound of
complexity.

**Integration (planned):** Same RSC parser as Case 6b, extended to handle streaming input. At build
time the integration forces all Suspense boundaries to resolve so it captures the full RSC payload
to hash against. At runtime the RSC parser processes chunks incrementally and finalises once the
stream closes — no explicit full-buffer step, analogous to how the HTML parser handles Case 4.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/x-component
Transfer-Encoding: chunked

1:I["(app-browser)/./src/app/dashboard/page.tsx",["app/dashboard/page"],"default"]
0:["$","main",null,{"children":[["$","h1",null,{"children":"Dashboard"}],"$L2"]}]
...
2:["$","section",null,{"className":"fast-stats","children":["$","p",null,{"children":42}]}]
...
3:["$","p",null,{"className":"timestamp","children":"2026-06-23T14:32:17.000Z"}]
```

The initial shell (lines `1:`, `0:`) arrives immediately. Each `...` marks a Suspense boundary
resolving (~200 ms). Dynamic values only appear once their boundary resolves, so the RSC parser
cannot finalise the structural hash until the stream closes.

---

## Case 8 — Inline script data partial

**Route:** `GET /partials/script-data` **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR) **Destination:** `""` (fetched by JS)

An SSR partial that embeds dynamic data inside a `<script type="application/json">` tag within the
HTML fragment. This pattern is common for passing server data to client-side JS without a separate
API call.

**Verification:** The HTML parser must handle `<script>` tags specially. The tag itself is
structural (its `type` attribute, its `id`) but its text content is dynamic JSON. The parser must
descend into the script content and apply JSON-aware heuristics to the extracted values — different
from plain text node heuristics.

**Integration (planned):** Same HTML parser as Cases 3 and 4, extended to recognise
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

**Verification:** Same HTML parser approach as Cases 3 and 4, but applied to a full document rather
than a fragment. The structural hash must cover the entire document skeleton.

**Integration (planned):** Same parser and heuristic approach. The main difference from Case 3 is
the interception point — the SW intercepts this as a navigation request rather than a plain fetch.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html

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
  <script src="/_astro/hoisted.CdQ1pWK.js"></script>
</body>
</html>
```

Same structural/dynamic split as Case 3 but over a full document. Asset hashes in the CSS/JS paths
are structural (fixed at build time); the text nodes are dynamic.

---

## Case 10 — Astro server islands

**Route:** fetched by Astro runtime at `/_server-islands/<ComponentName>` **Frameworks:** Astro only
**Render time:** Request time (deferred, after initial page load) **Destination:** `""` (fetched by
Astro's island runtime)

Astro's `server:defer` directive causes a component to be rendered server-side after the initial
page load. The Astro runtime fetches the component's HTML from a special `/_server-islands/` route
and injects it into the page — conceptually similar to a partial fetch, but the URL pattern and
request shape are Astro-specific.

**Verification:** The response is an HTML fragment (same shape as Cases 3–4). The HTML parser
approach applies. The additional challenge is that the URL contains the component name and a hash of
its props, so the manifest entry must match on a pattern rather than an exact path.

**Integration (planned):** The integration enumerates server island components at build time,
renders each with sentinel props, skeleton-hashes the result, and writes a pattern-matched entry
into the manifest. The service worker matches `/_server-islands/<name>` requests against the
pattern.

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
   than a full page render.

**Integration (planned):** Likely requires an explicit allowlist entry or a dedicated manifest type
for Server Action endpoints. The RSC parser from Case 6b would apply to the response, but the
action-specific parts (mutation results, revalidation tags) may not be structurally verifiable.

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

**Integration (planned):** The manifest could record
`{ "/redirect": { type: "redirect", to: "/live" } }`. The service worker checks that the `Location`
header matches the expected destination before following. This would catch a CDN-level redirect
hijack.

**Example response:**

```http
HTTP/1.1 302 Found
Location: /live
Content-Length: 0
```

Nobody — the only verifiable data is the `Location` header. A tampered CDN could change `/live` to a
malicious URL without touching any hashed asset.

---

## Case 13 — CSP nonce in script attribute

**Route:** `GET /partials/nonce` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `""` (fetched by JS)

The route sets a `Content-Security-Policy` response header with a per-request nonce and injects the
same nonce into a `<script nonce="…">` attribute. The nonce is a cryptographically random base64
value that changes every request.

**Verification:** The `nonce` attribute is a known-dynamic attribute — its value is per-request and
cryptographically random. The attribute _name_ is structural (hashed); the attribute _value_ is a
dynamic slot passed to Stage 2 for heuristic validation.

The browser already enforces that the nonce in the attribute matches the `nonce-{value}` token in
the `Content-Security-Policy` header as part of CSP enforcement — DappFence does not repeat that
check. DappFence's concern is narrower: was the nonce value tampered with or used as an injection
vector? A valid nonce is a base64-encoded random string. A value matching the base64 pattern cannot
carry HTML or script injection regardless of its content, so a format check is sufficient.

**Integration (planned):** The manifest records `nonce` as a dynamic attribute slot on `<script>`
and `<style>` elements with heuristic `base64-random`. The verifier checks that the extracted value
matches the pattern `[A-Za-z0-9+/]+=*` with a minimum length of ~22 characters (128 bits of
entropy). No response header inspection required.

**Example response:**

```http
HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'nonce-dGhpcyBpcyBhIG5vbmNl'

<div class="nonce-partial">
  <script nonce="dGhpcyBpcyBhIG5vbmNl">/* nonce-gated */</script>
  ...
</div>
```

The nonce attribute value is per-request. DappFence treats it as a known-dynamic attribute: the
value is stripped from the structural hash.

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

**Note on innerHTML injection:** When a partial containing an inline `<script>` is injected into the
page via `innerHTML`, the browser does **not** execute the script (this is a browser security
feature). DappFence must therefore verify the script content _before_ allowing the injection — not
after execution. This is the correct interception point: the service worker inspects the fetched
bytes before they are handed to the application.

**Integration (planned):** The HTML parser recognises `<script>` tags without a `type` attribute (or
with `type="text/javascript"`) and hands their content to a JS-aware extractor. The extractor
identifies top-level assignment patterns (`window.VAR = expr`, `var VAR = expr`) and extracts the
assigned value as a JSON-parseable object for the same two-bucket treatment as Case 8. The
structural hash covers the assignment target (`window.__WIDGET_STATE__`); the dynamic values inside
the object literal are verified separately.

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

## Case 15 — Conditional elements in SSR partial ⚠️ CRITICAL

**Route:** `GET /partials/conditional` **Frameworks:** Astro + Next.js **Render time:** Request time
(SSR) **Destination:** `""` (fetched by JS)

An SSR partial whose element count varies between requests based on server-side conditions. Some
elements are only rendered when a predicate is true — e.g. a "milestone" badge every Nth request, or
an alert row when a value falls below a threshold. Two independent boolean conditions produce up to
four distinct structural variants.

**Why this matters:** Conditional rendering is the norm, not the exception. Auth state, feature
flags, empty states, error banners, role-based UI — most real SSR components produce structurally
different HTML depending on server-side conditions. Case 3 (fixed skeleton) is the rare case; this
is the common one. The approaches below define DappFence's practical ceiling for SSR response
verification. See also **Case 18** for the unbounded variant problem, where even enumeration breaks
down.

**Why Case 3 does not apply:** Case 3's skeleton/template hashing requires a fixed structural
skeleton. When an element appears in one response but not another, the token index of every
subsequent sibling shifts. The structural hash of "skeleton without the badge row" is entirely
different from the hash of "skeleton with the badge row" — they cannot be compared against a single
manifest entry. The diff-based approach breaks completely: there is no stable alignment between
renders.

**Possible verification approaches:**

1. **Variant enumeration** — If the set of possible structures is small and enumerable at build
   time, each variant gets its own manifest entry. The verifier tries each known variant until one
   matches. Works for a small number of independent boolean conditions (2 conditions → 4 variants, 3
   → 8); breaks down combinatorially beyond that.

2. **Per-position optionality markers** — The manifest records that at structural position P an
   element may optionally appear, and if present must have exactly structure S. The verifier checks:
   "present or absent? If present, does it match S?" This avoids full enumeration but requires a
   richer manifest schema than Case 3.

3. **Merkle-style subtree hashing** — Each subtree is hashed independently. Conditional subtrees
   contribute a "present" or "absent" leaf to the root hash. The manifest records the root hash for
   each combination of present/absent leaves. Equivalent to variant enumeration but expressed as a
   tree rather than a flat list.

**Integration (planned):** Variant enumeration is the pragmatic starting point. The integration
calls the route with sentinel inputs that cover each branch, hashes each structural variant, and
writes one manifest entry per reachable variant. At runtime the verifier tries all known variants
for the requested path.

**Buffering cost of variant enumeration**

Variant enumeration forces full response buffering. This is a regression from Case 3, which can
stream-verify:

-   **Case 3 (fixed skeleton):** The manifest stores the extraction point positions in advance. As
    bytes arrive the SW simultaneously accumulates the structural hash and extracts values at known
    positions — streaming-native, O(1) in memory.
-   **Case 15 (conditional):** The variant cannot be identified until the skeleton hash is computed.
    The skeleton hash requires the complete response. The SW must buffer the entire response,
    identify the variant by hash, then verify dynamic values. Buffer-then-verify, regardless of
    whether the origin streams.

The circular dependency: **need variant → need skeleton hash → need full buffer.**

The only escape is early disambiguation — a server-emitted marker on the root element
(`data-variant="milestone+alert"`) lets the SW identify the variant from the first token and switch
to streaming mode. But this requires a server-side change and shifts trust to the marker value
itself.

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
        <dd>every 3rd request</dd>
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

Two independent boolean conditions → up to 4 structural variants. A single skeleton hash cannot
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

**Integration (current):** The integration hashes the static file at build time and writes the hash
into `manifest.files`. The service worker's fetch event handler must include `destination: "script"`
in its intercept filter alongside the existing `""` and `"document"` filters.

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
manifest cannot enumerate them all.

**Possible verification approaches:**

1. **Pattern-based allowlist** — The manifest records `/api/item/:id` as an allowlisted pattern. The
   service worker passes these requests through without hashing (same as Case 5 for JSON endpoints).
   No integrity check; only the URL pattern is "trusted."

2. **Structure-only hash** — If the response body has a fixed schema regardless of the ID (same JSON
   keys every time, only leaf values differ), skeleton/template hashing from Case 3 applies. The
   manifest records the structural hash of the response template; the service worker verifies
   structure but not data values.

3. **ID allowlist** — If the set of valid IDs is small and known (e.g. a product catalog with a
   fixed SKU list), enumerate them at build time (same as Case 2). Only viable when the set is truly
   finite and stable.

**Integration (planned):** Option 1 (pattern allowlist) is the baseline. The integration writes
`{ "/api/item/:id": { type: "allowlist" } }` into the manifest. The service worker matches requests
against the pattern and passes them through. Option 2 (structure-only hash) becomes available once
the skeleton hashing from Case 3 is implemented.

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

**Why Case 15 (variant enumeration) does not scale:** Each distinct value of N produces a
structurally different response — a different number of `<li>` elements. Variant enumeration
requires one manifest entry per reachable structure. For N=0..6 that is 7 entries. For a real
pagination endpoint returning 0..100 rows that is 101 entries. For an unbounded result set,
enumeration is impossible by definition.

**Why Case 3 (skeleton hashing) does not apply:** Skeleton hashing requires a fixed element count. A
list with N items has N `<li>` children — a structurally different skeleton for every distinct N.
There is no single skeleton hash that covers all responses from this route.

**This is the hard limit of response-body verification.** No hashing strategy over the response body
can verify this route without knowing N in advance. The only options are:

1. **Allowlist** — no structural verification; the URL pattern is trusted but the response is not
   inspected.
2. **Redesign the response** — render a fixed container and push the list data into a
   `<script type="application/json">` block (Case 8). The skeleton is now fixed; the list items are
   verified via JSON extractor rather than structural hashing.
3. **Verify the code, not the response** — if the JS bundle and server templates are verified (Cases
   1/16), the code generating the response is trusted. The response body itself is not verified; the
   guarantee comes from knowing the right code is running.

**Integration (planned):** Allowlist only. The manifest records
`{ "/partials/variable-list": { type: "allowlist" } }`. No structural hash is possible.

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
Skeleton hashing and variant enumeration both fail.

---

---

## CSP injection — what DappFence does today for navigation responses

Before examining specific cases, this section describes DappFence's _current_ implementation for
full page navigations. The future planning cases (3, 6, 7, etc.) require new parsers that are not
yet built. CSP injection is available now, in the current release.

**How it works:**

When DappFence intercepts a `destination: "document"` request, it injects a
`Content-Security-Policy: script-src` header into the navigation response before it reaches the
browser. The policy enumerates the SHA-256 hashes of every inline `<script>` body found in that page
at build time:

```http
Content-Security-Policy: script-src 'sha256-<hash1>' 'sha256-<hash2>' <connect-origins>
```

The browser enforces this policy: any inline script whose body does not match one of the listed
hashes is blocked from executing. External scripts (`<script src="...">`) are verified separately by
the service worker's file-hash checks.

**What it protects:**

A CSP-level injection attack — where a CDN or man-in-the-middle adds a new `<script>evil()</script>`
to a page's HTML — is blocked because the injected script body was not in the manifest at build
time, so its hash is absent from the policy.

**The precondition: hash stability**

CSP hashes are pre-computed at build time. They are only valid if the inline script body is
**byte-for-byte identical on every response**. Three things can break this:

1. **Per-request data embedded in a script body** — if the server renders
   `<script>window.DATA = {count: N}</script>`, the hash is different on every request. DappFence
   emits a build warning but cannot pre-hash per-request content. See Case 20 for this scenario.

2. **Nonce-based CSP already in use** — if the server injects `<script nonce="...">`, the nonce
   value in the attribute does not affect the script body hash; it is per-request randomness in the
   _attribute_, not the body. DappFence emits a warning about this when detected, because it signals
   the server is already using nonce-based CSP. See Case 13.

3. **CDN/proxy transform** — some CDNs inject or modify inline script content in transit. This is
   indistinguishable from an attack from DappFence's perspective and is precisely the threat the CSP
   is defending against.

**What it does not protect (for non-navigation requests):**

CSP injection only applies to navigation responses (`destination: "document"`). Partials fetched via
JS (`destination: ""`) are not wrapped with a CSP header — they are subject to body hash
verification for static routes, or no verification for fully dynamic routes.

---

## Case 19 — Parameterized SSR navigation without `getStaticPaths`

**Route:** `GET /partials/dynamic/[id]` **Frameworks:** Astro + Next.js **Render time:** Request
time (SSR) **Destination:** `"document"` (full page navigation)

A full HTML page with non-enumerable path parameters. The IDs are runtime values — they cannot be
pre-enumerated at build time, so the integration cannot fetch the page to extract inline script
hashes.

**What happens today:**

DappFence injects a CSP header on every navigation to `/partials/dynamic/[id]`. Because no page was
fetched at build time for this route, `manifest.csp.pages` has no entry for it. The injected CSP
contains no inline script hashes:

```http
Content-Security-Policy: script-src 'self' <connect-origins>
```

The browser enforces this: **all inline `<script>` blocks on this page are blocked** — including the
framework's own initialization scripts (the Astro theme-toggle bootstrapper in `BaseHead.astro`, or
the equivalent inline script in Next.js `layout.tsx`). Dark mode does not initialise.

**The theme bootstrapper is the clearest symptom**

The theme-toggle script (e.g., `localStorage.getItem('theme')` → add `dark` class) has a _static
body_ — it is identical on every page. Its hash IS computed and stored for pages that were scanned
at build time (the index page, the about page, etc.). But `manifest.csp.pages` is per-page: the hash
recorded for `/index.html` is not reused for `/partials/dynamic/foo`. Each page's CSP entry is built
exclusively from that page's own scan. Since `/partials/dynamic/foo` was never scanned, its entry is
empty.

**Forcing function:**

This is intentional. An inline script on a page whose CSP entry cannot be computed at build time is
an unverifiable code execution vector. DappFence's response is: don't let it execute.

The developer has three options:

1. **Move the script to a `.js` file** — external scripts are file-hash verified; the inline script
   problem disappears.
2. **Remove the inline script** — if the script only initialises state from server data, use
   `<script type="application/json">` (a data island, not executable — see Case 20).
3. **Use `getStaticPaths`/`generateStaticParams`** — if the valid IDs are finite and known at build
   time, enumerate them and convert this to Case 2 (parameterized static).

**Comparison with Case 2:**

Case 2 (`/partials/[id]`) uses `getStaticPaths` / `generateStaticParams`, so the integration fetches
each concrete URL at build time, computes CSP inline script hashes, and writes them to
`manifest.csp.pages['/partials/[id]']`. Case 19 has no `getStaticPaths` counterpart — the
integration cannot enumerate the IDs, so no hashes are computed and inline scripts are blocked
preemptively.

**Example response:**

```http
GET /partials/dynamic/report-42

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'self'   ← injected by DappFence; no inline hashes

<!DOCTYPE html><html lang="en">
<head>
  <!-- BaseHead theme-toggle script → BLOCKED -->
  <script>(function(){var s=localStorage.getItem('theme');...})();</script>
</head>
<body>
  <h1>Dynamic · report-42</h1>
  <script>initReport("report-42");</script>  ← also blocked
</body>
</html>
```

Both the framework bootstrapper and the page-specific script are blocked. Moving page logic to a
`.js` file resolves the page-specific script; the bootstrapper requires that this page be added to
the scan list (either via `getStaticPaths` or by configuring explicit CSP page entries in the
manifest).

---

## Case 20 — SSR navigation with per-request inline script data

**Route:** `GET /inline-data` **Frameworks:** Astro + Next.js **Render time:** Request time (SSR)
**Destination:** `"document"` (full page navigation)

A full HTML page with two data-passing patterns side by side:

1. **Executable inline script** — `<script>window.__serverTime = 1720879200123;</script>` The body
   contains `Date.now()` rendered at request time. Every millisecond produces a different hash.

2. **JSON data island** — `<script type="application/json" id="__df_server_time">{…}</script>`
   `type="application/json"` makes this non-executable. The browser's CSP `script-src` directive
   does not apply to it at all — no hash is needed, and the value changes freely.

**What happens today:**

`@dappfence/next` starts a programmatic Next.js server at build time and probes every
`force-dynamic` fixed route (see `hashSSRRoutes`). For `/inline-data`, the probe fetches the page
once at timestamp T1 and extracts all inline script hashes. Those hashes are stored in
`manifest.csp.pages['/inline-data']`.

On the next request, `Date.now()` returns T2 ≠ T1:

```http
GET /inline-data   (build-time probe, T1 = 1720879200123)

Content-Security-Policy: script-src 'sha256-H1' ... 'self'
<script>window.__serverTime = 1720879200123;</script>  ← H1 captured at T1
```

```http
GET /inline-data   (runtime request, T2 = 1720879200456)

Content-Security-Policy: script-src 'sha256-H1' ... 'self'  ← CSP unchanged; built at T1
<script>window.__serverTime = 1720879200456;</script>  ← H2 ≠ H1 → BLOCKED
```

The JSON data island with the same timestamp is **never blocked** — `script-src` does not govern
`<script type="application/json">`.

### Next.js App Router: the RSC cascade

For Next.js App Router, a third pattern is implicitly present alongside the two explicit ones.

**Pattern C — RSC push scripts**

Next.js App Router sends the rendered HTML and the React component tree in the same HTTP response.
The component tree (the RSC payload) arrives as a series of inline scripts:

```html
<script>
    self.__next_f = [];
</script>
<script>
    self.__next_f.push([0, '...layout RSC data...']);
</script>
<script>
    self.__next_f.push([1, '...page RSC data...']);
</script>
```

Each `self.__next_f.push(...)` script serializes part of the React component tree in RSC wire
format. For `/inline-data`, the component renders `serverTime` as text content in several `<code>`
elements. Those text nodes are encoded into the RSC wire format. Since `serverTime` changes every
request, the RSC push scripts have a different body on every render — the same hash-instability
problem as Pattern A, but implicit and not written by the developer.

**Why the whole page disappears**

Blocking the RSC push scripts does not fail silently the way blocking Pattern A does. It triggers a
cascade that tears down the whole page:

1. **Server sends the HTML.** The rendered HTML is in the response body. The browser paints the page
   content immediately — elements, text, and cards are all visible.

2. **RSC push scripts are blocked by CSP.** Their hashes differ from the build-time probe hashes.
   `self.__next_f` is initialized as `[]` but receives no data.

3. **React's hydration bootstrap runs.** Next.js's client code calls:

    ```js
    React.createFromReadableStream(ReadableStream.from(self.__next_f));
    ```

    The array is empty. The stream closes with no component tree data → **`Connection closed`**
    error.

4. **Error propagates to the root.** The error surfaces in Next.js's root `<AppRouter>` component.
   There is no error boundary at the root to catch it.

5. **React unmounts the entire tree.** React removes all DOM nodes it was hydrating. The
   server-rendered HTML that was briefly visible disappears. The page goes blank.

**Why the violation report is hard to read**

The CSP violation report for a blocked RSC push script shows `lineNumber: 1` and `sample: ""`:

-   `lineNumber: 1` — Next.js renders the entire HTML response as one long line in production; all
    inline scripts appear at line 1 regardless of their structural position in the document.
-   `sample: ""` — DappFence's CSP does not include `'report-sample'`, so Chrome never populates the
    sample field. A violation from an RSC push script looks identical in the report to one from
    Pattern A.

**How dynamicRSC resolves this**

DappFence's `dynamicRSC` mode intercepts the `securitypolicyviolation` events fired when the browser
blocks RSC push scripts, pattern-validates each blocked script (`self.__next_f.push([...])` only —
strict regex, no other forms accepted), and re-executes the RSC payload by calling
`self.__next_f.push(parsedArray)` directly. This restores hydration without allowing arbitrary
script execution. The Pattern A script fails validation (it is not an RSC push expression) and
remains blocked. See [CSP Injection Strategy — dynamicRSC](./csp-injection-strategy.md#dynamicrsc)
for the mechanism.

**The fix:**

Replace the executable inline script with a JSON data island:

```html
<!-- Before (hash instability): -->
<script>
    window.__serverTime = 1720879200456;
</script>

<!-- After (stable): -->
<script type="application/json" id="__df_server_time">
    { "serverTime": 1720879200456 }
</script>
<script src="/app.js"></script>
← reads the island on load; this file is file-hash verified
```

The body of `/app.js` never changes (static file); its hash is in `manifest.files`. The per-request
timestamp lives in the JSON island, which CSP ignores entirely.

**Contrast with Case 8:**

Case 8 describes the same `<script type="application/json">` pattern for a _partial_ (fetched by JS,
`destination: ""`). Case 20 is the _navigation_ (`destination: "document"`) version. The fix is
identical; the context differs — CSP injection only applies to navigation responses.

---

## Case 21 — ISR page (revalidate)

**Route:** `GET /news` **Frameworks:** Next.js only **Render time:** Build time + periodic
regeneration (ISR, `export const revalidate = 60`) **Destination:** `"document"` (full page
navigation)

A Next.js App Router page that is pre-rendered at build time and cached, but regenerated in the
background every `revalidate` seconds when a new request arrives after the TTL expires.

**What DappFence captures at build time:**

`walkHtmlFiles` reads `.next/server/app/news.html` after `next build` and records two things:

1. Body hash → `manifest.files['/news'] = sha256-H1`
2. Inline script hashes → `manifest.csp.pages['/news']` (layout bootstrapper + RSC push scripts at
   their build-time values)

**What happens after ISR regeneration:**

The server re-renders the page at TTL expiry. Two things change:

1. **Body hash becomes stale.** The regenerated HTML has a new body hash `H2 ≠ H1`. The manifest
   still says `H1`. Navigation body verification (when implemented) will flag this as a mismatch.

2. **RSC push scripts change.** `self.__next_f.push(...)` scripts contain the serialized React
   component tree. Any data in the component tree (a headline, a counter, a timestamp) that changed
   during revalidation produces new push scripts with new hashes. The CSP policy still lists the
   build-time hashes → the new push scripts are blocked → same React hydration cascade as Case 20.

**Relationship to Case 20:**

| Dimension            | Case 20 (`force-dynamic`)                           | Case 21 (ISR, `revalidate`)                                 |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| Initial page load    | No stable hash (force-dynamic is never prerendered) | Matches manifest (prerendered at build)                     |
| Body hash            | Never added to manifest                             | Added at build time; becomes stale after first revalidation |
| RSC push scripts     | Always blocked by CSP (data changes every request)  | Stable until first revalidation; blocked after              |
| `dynamicRSC` needed? | Yes, from first load                                | Yes, from first revalidation onward                         |

**What happens today:**

On the first load (before any revalidation), everything works: the body matches `H1`, the CSP hashes
match the build-time push scripts. After the first revalidation cycle, the RSC push script hashes
change and the React cascade from Case 20 begins. Once navigation body verification is implemented,
the body hash mismatch (`H2 ≠ H1`) will also surface.

**Recommendation:**

Enable `dynamicRSC` mode for any route with `revalidate`. The body hash staleness will become a
false-positive trigger once navigation body verification ships; at that point ISR routes should be
excluded from `manifest.files` and treated the same as `force-dynamic` routes from the body-hash
perspective.

**Example response (first load — build-time cache hit):**

```http
GET /news

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'sha256-H1-layout' 'sha256-H1-rsc-init' 'sha256-H1-rsc-push' 'self'

<!DOCTYPE html><html lang="en">
<head>
  <script>(function(){var s=localStorage.getItem('theme');…})();</script>  ← H1-layout, stable
</head>
<body>
  …
  <script>self.__next_f=[];</script>                                        ← H1-rsc-init, stable
  <script>self.__next_f.push([0,"…layout tree…"]);</script>                 ← H1-rsc-push, stable at this build
  <script>self.__next_f.push([1,"…page tree with headline text…"]);</script> ← H1-rsc-push, changes on revalidation
</body>
</html>
```

**Example response (after ISR revalidation — new content):**

```http
GET /news

HTTP/1.1 200 OK
Content-Type: text/html
Content-Security-Policy: script-src 'sha256-H1-layout' 'sha256-H1-rsc-init' 'sha256-H1-rsc-push' 'self'
  ↑ CSP is unchanged — manifest was built at H1

  <script>self.__next_f.push([1,"…updated page tree…"]);</script>  ← H2-rsc-push ≠ H1-rsc-push → BLOCKED
```

The layout bootstrapper hash (`H1-layout`) and RSC init hash (`H1-rsc-init`) are stable — they pass.
The page-level RSC push script changed with the revalidation → blocked → React cascade.

---

## Verification limits

This section synthesizes where DappFence's guarantees hold, degrade, and break entirely.

### Current guarantee — CSP inline script injection on navigations

DappFence injects a `Content-Security-Policy: script-src` header on every navigation response,
listing the SHA-256 hashes of all inline scripts found at build time. Any inline `<script>` injected
by a CDN or MITM is blocked because its hash is absent from the policy. For fully dynamic pages (no
build-time hash entry), the policy contains no inline hashes and all inline scripts are blocked
preemptively (Cases 19, 20).

This is the **only response-content protection that is currently implemented**. Everything below is
planned.

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

-   Full response buffering required — cannot stream-verify (see buffering cost note in Case 15)
-   Build-time tooling must trigger every variant to record its skeleton hash
-   Combinatorial explosion: 5 boolean conditions → 32 variants; non-boolean branching → unbounded

### No guarantee — unbounded structural variants (Case 18)

When element count is data-driven, skeleton hashing and variant enumeration both fail. Allowlist is
the only option at the response-body level.

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

| Attack vector                                            | DappFence response                                          |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Tampered static JS/CSS bundle                            | Caught — Cases 1, 2, 16 (full hash)                         |
| New `<script>` injected into static page navigation      | Caught — CSP injection; injected hash not in policy         |
| Inline script body altered on a static page              | Caught — CSP; modified body hash does not match policy      |
| New `<script>` tag injected into fixed-skeleton SSR      | Caught — Case 3 (skeleton hash, structural change, planned) |
| New `<script src="x">` injected into any SSR response    | Caught when `x` loads — Case 16 (asset not in manifest)     |
| New inline `<script>` injected into dynamic SSR response | Caught — CSP injection blocks it (no hash in policy)        |
| Inline script body changed to embed malicious payload    | Caught — CSP; changed body hash does not match              |
| Parameterized SSR page with no precomputed hashes        | All inline scripts blocked preemptively — Case 19           |
| Per-request data in inline script (hash instability)     | Script blocked on all but build-time render — Case 20       |
| ISR page regenerated after manifest build                | RSC push scripts blocked after first revalidation — Case 21 |
| `<script type="application/json">` tampered              | Not caught — CSP `script-src` does not govern data islands  |
| Data values modified in SSR response                     | Not caught (not the primary threat)                         |
| Redirect hijacked to malicious destination               | Case 12 (Location header)                                   |
| RSC wire format tampered                                 | Case 6/7 (RSC parser, planned)                              |
| Nonce attribute value replaced                           | Not caught — value is excluded from hash by design          |
