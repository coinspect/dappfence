# SSR / On-demand Route Verification

## Current behavior

DappFence verifies responses by comparing their SHA-256 hash against the signed manifest. This works
perfectly for static files produced at build time. For server-rendered (SSR) routes the manifest
records the route patterns under `dynamicRoutes` as metadata, but the service worker does not
currently use that list to adapt its verification — an SSR response would be flagged as
`NOT_FOUND_IN_MANIFEST` and treated as a violation.

## Why this matters

An attacker who controls the server can inject a `<script>` tag, an `onerror` attribute, a
`javascript:` href, or a remapped importmap into any SSR response. Without extraction-based
verification, DappFence's integrity guarantee does not extend to on-demand pages.

## Proposed approaches

### Option 1 — Marker-based skeleton hashing

Developers annotate dynamic regions in their templates:

```html
<h1><!-- df:dynamic -->Hello, Juan<!-- /df:dynamic --></h1>
<script src="/app.js"></script>
```

**Build time** (integration): strip every `<!-- df:dynamic -->…<!-- /df:dynamic -->` region, hash
the remaining skeleton, record it in the manifest against the route pattern.

**Runtime** (service worker): strip the same markers from the SSR response body, hash the result,
compare against the manifest.

Stripping is a plain regex — no DOM parser is needed, and it works on raw bytes before the response
reaches the page.

| Pros                                        | Cons                                         |
| ------------------------------------------- | -------------------------------------------- |
| Simple to implement                         | Developer must annotate every dynamic region |
| Full skeleton is verified                   | Easy to forget a region                      |
| Extends naturally to partial HTML fragments | Annotation drift over time                   |

### Option 2 — DOMParser extraction (primary mechanism)

Instead of hashing the whole page, the SW parses the HTML response with `DOMParser` and extracts the
security-critical content into three independently verified manifest entries:

| Manifest entry         | What is extracted                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pageKey + #scripts`   | Text content of all `<script>` elements (excluding `type="importmap"` and data islands)                                            |
| `pageKey + #handlers`  | All `on*` attribute values on any element; `href`, `action`, `formaction`, `src` (iframe/frame) values starting with `javascript:` |
| `pageKey + #importmap` | Text content of `<script type="importmap">` elements                                                                               |

Each entry is verified as a set-membership check — every extracted item must have a matching hash in
the manifest set. An injected element or attribute not present at build time produces a hash not in
the set, triggering a violation. Manifest entries with no matching extracted item are silently
ignored — they represent other known-good versions, not required content.

**`DOMParser` availability in SW**: `DOMParser` is available in service worker context in Chrome
119+ (October 2023) and Firefox.

**Build time**: for each route pattern, render the page once and run the same three extractions to
populate the manifest entries.

**Runtime**: the SW receives the HTML response, parses it with `DOMParser`, runs all three
extractions in a single DOM walk, then checks each result against its manifest entry.

| Pros                                                          | Cons                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Zero annotation burden                                        | Requires per-route manifest entries                       |
| Covers scripts, event handlers, javascript: hrefs, importmaps | Inline scripts must be static at build time (see caveats) |
| Single DOM walk for all three extractions                     |                                                           |
| Correct HTML semantics — no regex fragility                   |                                                           |

## Recommended path

Implement **Option 2** (DOMParser extraction) as the primary mechanism — it requires no changes to
application templates and directly addresses all known SSR injection vectors in one pass. Layer
**Option 1** on top for teams that want full skeleton coverage or need to protect page content
beyond the extracted elements.

Both options require:

-   Manifest schema additions (`#scripts`, `#handlers`, `#importmap` entries per route key,
    alongside the existing `dynamicRoutes` array).
-   SW fetch handler: match the request path against known dynamic route patterns and route to the
    extraction-based verification path instead of the standard hash check.
-   Integration: a build step to render each SSR route once and capture the three manifest entries.

---

## Implementation design

### Single-pass buffering with deferred response delivery

The SW cannot start sending the HTML response to the browser before verification completes — if a
violation is detected after partial delivery, the browser has already received and begun rendering
injected content, and a redirect to the block page is no longer possible via HTTP headers.

Instead, the SW reads the full response body, parses it with `DOMParser`, and runs all three
extractions in a single DOM walk before returning the response:

```js
const body = await response.text();
const bodyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
const doc = new DOMParser().parseFromString(body, 'text/html');
const scripts = extractInlineScripts(doc); // #scripts
const handlers = extractHandlers(doc); // #handlers
const importmaps = extractImportmaps(doc); // #importmap
// verify each set against manifest entries
// if ok:
return new Response(body, { status: response.status, headers: response.headers });
```

Memory cost: O(document size) for the text buffer, plus the DOM tree built by `DOMParser` —
unavoidable for pre-delivery verification with correct HTML semantics.

### Stream-to-browser with postMessage violation redirect

An alternative that avoids delivery latency: the SW tees the response and streams one branch
immediately to the browser while the other branch is buffered. Once buffering is complete,
`DOMParser` extracts inline content and the body hash is computed. If a violation is detected, the
SW sends a violation postMessage to the page client.

This works because:

1. `dappfence.js` is loaded as a synchronous `<script>` in `<head>`, so it is always running before
   any `on*` handler or other event can be dispatched (all `on*` handlers fire asynchronously — none
   execute during parsing).
2. The SW uses `event.resultingClientId` from the navigation fetch event to target the postMessage
   at the new page's client.
3. The existing `CLIENT_READY` / message-broker infrastructure queues the violation message and
   delivers it when `dappfence.js` sends `CLIENT_READY` on load.
4. `dappfence.js` calls `location.replace(warningUrl)` on receipt — this triggers a navigation that
   cancels pending tasks in the current document.

**Timing**: detection happens at EOF (set-membership requires the full document). By then the page
is fully rendered but no `on*` handler has fired — user interaction events and image load failures
are async and arrive after the redirect has been initiated. The brief render window is a known
residual risk, not a silent bypass — the violation is recorded and the session is terminated.

**Tradeoff summary**:

| Approach             | Memory      | Delivery latency | Violation timing            |
| -------------------- | ----------- | ---------------- | --------------------------- |
| Buffer then verify   | O(document) | +parse time      | Block before render         |
| Stream + postMessage | O(document) | None             | Redirect after render (EOF) |

Both approaches are valid. Buffer-then-verify is simpler and gives a clean block page with no render
flash. Stream + postMessage has no delivery latency cost and leverages existing DappFence client
infrastructure, at the cost of a brief render window before the violation redirect fires.

---

## Known limitations and caveats

### `on*`, `javascript:` attributes, and importmaps — planned, not yet implemented

All three gaps are closed by Option 2's DOMParser extraction phase. Until the `#handlers` and
`#importmap` manifest entries are implemented, operators of SSR routes should treat DappFence as
providing **inline `<script>` protection only** — not full page integrity — and must deliver a
strict CSP exclusively via HTTP headers (not via `<meta>` tag, which an attacker controlling the
response body can override) to cover the remaining vectors.

### `#scripts` requires inline scripts to be static at build time

The set-membership check in the `#scripts` manifest entry only works if the inline scripts in the
SSR response are identical across requests. If a framework embeds any per-request state into a
`<script type="text/javascript">` block — as opposed to a `type="application/json"` data island,
which the extractor skips — the hash of that block changes per request, and every page load triggers
a violation.

This assumption must be validated against each framework's actual output during integration. It
cannot be assumed — it must be confirmed by inspecting what the framework emits for each route type.
Inline scripts that embed dynamic data must be converted to data islands (`type="application/json"`)
or moved server-side before `#scripts` verification can be enabled for that route.

### Stream + postMessage: detection at EOF, not mid-stream

The `#handlers`, `#scripts`, and `#importmap` set-membership checks all require the complete
document before producing a result. Neither approach (buffer or stream) provides earlier-than-EOF
violation detection for these vectors. The security value is containment: the violation is recorded,
the session is terminated, and subsequent requests are blocked by the SW. It is not prevention of
the initial render.
