# JavaScript Execution Vectors in the Browser

This document catalogs every mechanism by which a browser can execute JavaScript, with notes on CSP
interaction and how DappFence can verify each one.

DappFence's primary verification path is the **service worker fetch event**: when a script resource
is fetched over the network, the SW can intercept it, hash the response body, and compare against
the signed manifest. Methods that bypass the network entirely require a different approach, noted
per entry.

---

## Coverage legend

| Symbol            | Meaning                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SW intercept      | Resource fetched over the network; SW fetch event fires; hash can be verified                                                                                  |
| HTML doc          | Script is baked into the HTML; covered transitively if the HTML document itself is verified                                                                    |
| SW monkey-patch   | DappFence patches the API inside the SW context                                                                                                                |
| Source-controlled | Execution originates from a verified script; the runtime behaviour is the developer's own code and outside DappFence's model                                   |
| External data     | A verified script passes runtime data from an external source into an eval-equivalent API; secondary concern requiring static analysis of the verified scripts |
| Browser-blocked   | No fetch event fires; browser engine prevents execution regardless of DappFence                                                                                |
| Planned           | Not yet implemented; a concrete design exists and is tracked for a future release                                                                              |

> **SSR caveat applies to "HTML doc" entries.** HTML document verification works by pre-hashing the
> page at build time. For SSR routes the HTML body is dynamic, so no stable document hash exists.
> Whether a specific vector remains covered on SSR depends on whether the manifest-rules pipeline
> has a dedicated extraction mechanism for it. See [Section 17](#17-ssr-inline-content-verification)
> for the precise breakdown.
>
> Short version: **inline `<script>` blocks are covered** on SSR via the `inline-script` synthetic
> destination and `#scripts` manifest entries (see
> [manifest-rules-design.md](manifest-rules-design.md)). **`on*` event handler attributes,
> `javascript:` hrefs, and import maps** are covered by the same post-fetch tokenizer extraction
> phase — see [Section 17](#17-ssr-inline-content-verification) for details.

> **Conservative parsing policy.** DappFence does not aim for spec-compliant HTML parsing. The goal
> is to extract every byte sequence that _could_ execute JavaScript in any browser under any
> conditions — including non-standard, malformed, or edge-case markup. A script inside `<template>`,
> an `on*` attribute on a foreign-content element, or a `xlink:href="javascript:"` on an SVG anchor
> are all treated as execution vectors regardless of whether the HTML5 spec requires the browser to
> execute them. False positives (flagging something the browser would not execute) are acceptable
> and resolved via manifest exceptions. False negatives (missing something the browser executes) are
> not acceptable.

> **DappFence as a forcing function.** When the tokenizer finds a pattern that must appear in the
> manifest — an inline `on*` attribute, a `<script>` inside `<template>`, a
> `xlink:href="javascript:"`, an unusual inline script — the developer has two options: add the hash
> to the manifest (acknowledging it consciously) or refactor the code to eliminate the pattern. Both
> outcomes improve security. DappFence is not designed to silently accommodate every coding pattern;
> it is designed to surface patterns that carry execution risk and force an explicit decision. The
> manifest exception mechanism is a controlled escape valve for cases where the pattern is
> intentional and understood, not a silent default that absorbs anything the framework emits. This
> is the same principle that makes DappFence incompatible with tag managers and JSONP: the
> incompatibility is the security property, not a gap to be bridged.

---

## 1. Standard `<script>` elements

### 1a. External classic script

```html
<script src="/app.js"></script>
```

The browser fetches the URL, parses, and executes the response. Async/defer variants change when
execution happens but not how the resource is fetched.

**CSP**: controlled by `script-src` directive. Nonce or hash is required under strict CSP.

**DappFence**: **SW intercept** the fetch fires, DappFence hashes the response body and blocks or
warns if it does not match the manifest.

**`no-cors` / opaque response issue**: a `<script src>` tag without a `crossorigin` attribute makes
a no-cors request. The SW receives `response.type === "opaque"`, `arrayBuffer()` returns empty
bytes, and the body cannot be hashed. Critically, the browser's internal network layer still has the
actual bytes and **will execute the script** regardless of what the SW sees. Passing an opaque
response through is therefore a silent verification bypass.

This affects virtually every production web app. Cross-origin scripts without `crossorigin` are the
norm: analytics (GTM, GA4, Mixpanel), payments (Stripe, PayPal), chat widgets (Intercom, Zendesk),
maps (Google Maps, Mapbox), CDN-hosted libraries from jsdelivr/cdnjs/unpkg, and any Next.js app
using `assetPrefix`. The no-cors case is the common case, not an edge case.

**Detection**: `request.destination` in the SW fetch event reliably identifies the resource type.
Script tag fetches produce `destination === "script"` regardless of whether `crossorigin` is
present. `fetch()` and `XHR` calls produce `destination === ""` (displayed as "other" in DevTools).
This means the SW can target the mitigation precisely without affecting non-script fetches.

**Mitigation: SW CORS retry**. When the SW sees `destination === "script" && mode === "no-cors"`, it
discards the original request and re-issues it as a new CORS request to the same URL. The browser
has not yet made the actual network call when the fetch event fires, the SW is fully in control of
what gets fetched:

```js
if (request.destination === 'script' && request.mode === 'no-cors') {
    try {
        const corsResponse = await fetch(
            new Request(request.url, {
                mode: 'cors',
                credentials: 'omit',
            })
        );
        const body = await corsResponse.clone().arrayBuffer();
        // hash body, verify against manifest block or pass through
        return corsResponse;
    } catch {
        // CDN does not support CORS, or CORP header blocks the fetch
        logWarning(
            request.url,
            'no-cors script blocked self-host this script or add a named trust exception'
        );
        return emptyStub();
    }
}
```

The browser accepts a CORS response from the SW to fulfill a no-cors fetch event, the SW is a
trusted same-origin intermediary, and the browser does not re-validate. This approach requires no
HTML parsing and covers all script fetches whether parser-inserted (in the initial HTML) or
dynamically inserted by app JavaScript at runtime.

**Why not HTML rewriting**: an alternative is to parse the HTML document response in the SW and
inject `crossorigin="anonymous"` into `<script>` tags before returning it to the browser. This was
considered but rejected in favor of CORS retry:

-   HTML parsing is fragile (regex insufficient; requires a proper parser)
-   Only covers parser-inserted scripts; dynamically inserted scripts still need SW handling
-   CORS retry at the fetch level handles both cases uniformly with no parsing

**SRI interaction**: `crossorigin` is also required for SRI (`integrity` attribute) to activate on
cross-origin scripts. Without `crossorigin`, the browser silently ignores the `integrity` attribute
for cross-origin `<script>` elements. This means CORS retry also enables SRI as a browser-level
defense-in-depth layer: if the SW has the hash in the manifest, it can simultaneously inject an
`integrity` attribute via HTML rewriting, giving a second independent verification point that
persists even if the SW is bypassed. This is additive to the SW verification, not a replacement.

**`crossorigin` and script execution context**: adding `crossorigin` does not change how the loaded
script executes. It still runs in the page's global scope with full DOM access. There is no
isolation or sandboxing all globals the script sets are accessible to page JS and vice versa. The
`crossorigin` attribute only affects the fetch mechanics, not execution context.

**`crossorigin` and no-cors protection**: no-cors opaque responses exist to prevent a page from
reading authenticated responses from other origins (protecting the server from cross-origin data
exfiltration). For CDN scripts this protection is largely moot, the content is public. Adding
`crossorigin` does not expose script source bytes to page JS (no such API exists regardless of CORS
mode). The CDN opts in by sending `Access-Control-Allow-Origin` headers; if it does not, the CORS
fetch fails and the SW falls back to the empty stub.

**Failure modes of CORS retry**:

-   CDN does not support CORS → SW fetch fails → empty stub → the script does not execute
-   CDN has `Cross-Origin-Resource-Policy: same-origin` → SW fetch blocked → same as above
-   CDN serves different content without credentials (e.g., A/B testing based on cookies) → content
    may differ from what no-cors would have returned
-   All failure cases produce a logged warning, not a silent failure

**The empty stub is a silent denial-of-service in production**: when a CDN does not support CORS (or
has a transient CORS misconfiguration), the script simply does not execute. If that script is
Stripe.js, a payment widget, or an identity provider SDK, the feature silently breaks, no
user-visible error, no fallback. A logged warning in the SW console is invisible in production.
Operators need pre-deployment tooling that probes each CDN script for CORS support and flags
failures before the site goes live. Without this, end-users discover CORS retry failures through
broken features.

**CDN content equivalence is an assumption**: the CORS retry design assumes the CDN returns
identical bytes for CORS and no-cors requests. This is true for static public libraries but not
universal. CDNs that perform geo-routing, A/B testing, or version pinning based on headers
(including the `Origin` header itself) may serve different content in CORS mode than the browser
would have received in no-cors mode. If the manifest hash was recorded against a CORS response from
one region or variant, but the runtime CORS response comes from a different region or variant, the
result is a constant hash mismatch that looks like an attack but is legitimate CDN behavior. Before
adding any CDN script to the manifest, confirm that the CDN does not vary content on `Origin`,
region, or session state.

**Manifest hash must be computed in CORS mode**: because the SW always fetches in CORS mode at
runtime, the hash recorded in the manifest must be computed from the CORS response body. The
manifest generation tooling must fetch CDN scripts with `Origin` present and `credentials: 'omit'`
to produce matching hashes. If the CDN returns `Vary: Origin` and serves different bytes depending
on whether `Origin` is present, the no-cors and CORS response bodies will differ and a manifest
built without CORS semantics will produce constant hash mismatches at runtime. In practice this only
affects CDNs that genuinely vary their script content by origin, public static libraries do not.

**`allow` rules are not an escape hatch**: an `allow` contentRule unconditionally trusts a URL
without any hash verification. Against DNS hijacking or CDN compromise, the primary threats
DappFence exists to prevent, an `allow` rule offers zero protection. The Polyfill.io attack (2024)
illustrates this precisely: the CDN was acquired and its script silently modified, compromising 100
thousand+ sites. Sites with SRI hashes were protected. An `allow` rule for polyfill.io would have
passed the attack through undetected.

When a script cannot be verified via CORS retry, the options in order of preference are:

1. **Self-host**: copy the script to your own origin or a CDN you control. Full hash verification is
   then possible, and version updates are explicit and go through your release cycle. This is the
   correct approach for any library where self-hosting is technically and contractually permitted
   (jQuery, React, Bootstrap, Lodash, etc.).

2. **Remove**: if the script cannot be verified and cannot be self-hosted, it should not run under
   DappFence. This is a legitimate security decision, unknown provenance means unknown risk.

3. **Named trust exception** (narrow, requires explicit acknowledgment): some scripts cannot be
   self-hosted due to compliance or technical constraints. Payment processors (Stripe.js from
   `js.stripe.com`, Braintree) and identity providers (Auth0, Okta) require their scripts to load
   from their own domain for PCI compliance and security patch control. For these, an `allow` rule
   is unavoidable, but the developer is already unconditionally trusting that provider at the
   infrastructure level, and DNS hijacking of `js.stripe.com` implies capabilities far beyond what
   any client-side framework can address.

    `allow` rules for named trust exceptions must be:

    - Scoped to an exact origin, never a URL prefix or wildcard
    - Accompanied by a documented reason why self-hosting is not viable
    - Flagged persistently in the DappFence security report
    - Explicitly acknowledged in the manifest before the build tool accepts them

**fetch() + exec bypass**: `destination` reliably identifies script tag fetches, but a verified
script could fetch content via `fetch()` (destination `""`) and then execute it via `eval()`,
`new Function()`, blob URL `<script>`, or `WebAssembly.instantiate(buffer)`. The SW sees the fetch
but not the execution step. These are permanent gaps (see sections 7a–7c, 8b, 12b). The originating
script must itself be verified for this to be a residual risk rather than a primary attack vector.

**Attacker-controlled data flowing into eval-equivalent APIs extends this gap.** A verified script
that calls `eval()` or `new Function()` on data received at runtime from `postMessage`, URL
parameters, `localStorage`, or a `fetch()` response executes code that was never verified. DappFence
confirmed the _script_ was not tampered with; it cannot verify the _data_ the script processes at
runtime. For applications where externally sourced data flows into eval-equivalent patterns, static
analysis of the verified scripts is required to determine whether verification is enough. This
matters most in DeFi and financial applications where wallet addresses, transaction parameters, and
user-controlled values flow through complex JS logic.

This issue also applies to any other script-destination fetch that produces an opaque response
(e.g., a same-origin redirect that follows to a cross-origin URL without CORS headers). See also
section 16a (JSONP).

---

### 1b. Inline classic script

```html
<script>
    doSomething();
</script>
```

No network request. The script text is part of the HTML document.

**CSP**: requires `'unsafe-inline'`, a nonce (`'nonce-...'`), or a hash (`'sha256-...'`).

**DappFence**: **SW intercept (inline-script)** the manifest-rules design introduces a synthetic
`inline-script` destination. After the SW fetches an HTML response, it extracts all `<script>` tags
without a `src` attribute (keeping `type` absent, `text/javascript`, or `module`; skipping data
islands and importmaps), hashes each one, and checks against `files[pageKey + "#scripts"]` as a
set-membership test. This is a separate post-fetch phase that runs regardless of whether the
document body itself was verified or allowed.

**On SSR routes**: the document body is allowed (not hashed, since it changes per request). Inline
script verification still fires if a `#scripts` entry exists in the manifest, so an attacker
injecting a new `<script>` block into the SSR response triggers a violation. This requires the
inline scripts to be static/known at build time, which is true for most SSR framework output
(hydration bootstraps, config embeds).

---

### 1c. `<script type="module">` (external)

```html
<script type="module" src="/module.js"></script>
```

Module scripts are fetched with CORS semantics. Imported submodules are fetched recursively.
Execution is always deferred.

**CSP**: `script-src` with strict-dynamic or explicit hash/nonce.

**DappFence**: **SW intercept** every module fetch (entry and transitive imports) fires the SW fetch
event. Each can be individually verified.

---

### 1d. Inline module script

```html
<script type="module">
    import '/other.js';
</script>
```

The inline portion is not fetched; the imported URLs are.

**DappFence**: inline portion → **SW intercept (inline-script)** the inline module text is extracted
and verified via `#scripts`, same as section 1b (the extractor keeps `type="module"`). Imported URLs
→ **SW intercept**. Both phases work on SSR routes.

---

## 2. HTML event handler attributes

```html
<img src="x" onerror="maliciousCode()" />
<body onload="init()">
    <input autofocus onfocus="steal()" />
    <details ontoggle="run()">
        <svg onload="run()"></svg>
    </details>
</body>
```

Any element can carry `on*` attributes. The attribute value is compiled into a function and called
on the corresponding DOM event. No network request.

**CSP**: blocked by `'unsafe-inline'` being absent from `script-src`. Nonce/hash on attributes is
not supported the only safe option is removing `'unsafe-inline'`.

**DappFence**: **HTML doc** the handler text lives in the HTML response body. Covered on static
routes because the full document hash is in the manifest.

**On SSR routes this is covered by the `#handlers` tokenizer extraction (see below).** The tokenizer
walks all opening tags and collects every `on*` attribute value. Injected `onerror`, `onload`,
`onfocus`, etc. on arbitrary HTML elements are extracted and checked against the manifest.

**Mitigation: custom tokenizer post-fetch extraction.** After the SW fetches an HTML response, a
purpose-built HTML tokenizer (bundled into `dappfence.js`, identical to the one used at build time
by the integration packages) scans the raw response bytes. It collects the value of every attribute
whose name begins with `on` on every opening tag, regardless of element type or namespace. Those
values are hashed and checked against a `pageKey + "#handlers"` manifest entry using the same
set-membership logic as `#scripts`. An injected attribute not in the manifest set triggers a
violation before the response reaches the browser.

The tokenizer deliberately extracts more broadly than a spec-compliant parser: `on*` attributes
inside `<template>`, on SVG/MathML elements, and in structurally invalid positions are all
extracted. If a developer's legitimate HTML uses `on*` attributes in unusual positions, those hashes
must appear in the `#handlers` manifest entry — or the markup should be refactored to use event
listeners.

---

## 3. `javascript:` protocol

### 3a. In markup

```html
<a href="javascript:doThing()">click</a>
<form action="javascript:submit()">
    <input type="submit" formaction="javascript:steal()" />
    <iframe src="javascript:document.write('<script>...')"></iframe>
</form>
```

The browser evaluates the expression in `javascript:` as a script when the link is followed or the
form is submitted.

**CSP**: `script-src` does not block `javascript:` navigations by default in all browsers;
`default-src` may. Behavior varies. `navigate-to` directive covers navigations in newer CSP3.

**DappFence**: **HTML doc** the `javascript:` literal is inside the HTML. Verified on static routes
via the document hash. Runtime injection from a verified script is transitively trusted.

**On SSR routes this is covered by the same tokenizer pass as section 2.** The tokenizer collects
`href`, `action`, `formaction`, `xlink:href`, and `src` (on `<iframe>` and `<frame>`) values that
begin with `javascript:` (case-insensitive prefix check) on every element. All are included in the
`pageKey + "#handlers"` manifest entry — one extraction phase closes all these gaps.

`xlink:href="javascript:"` on SVG `<a>` and `<use>` elements and MathML `<mi>` elements is treated
identically to `href="javascript:"` — it is an execution vector in all modern browsers and is
extracted regardless of namespace.

---

### 3b. Via `location`

```javascript
location.href = 'javascript:alert(1)';
```

No markup, no fetch. Executed programmatically from an existing script.

**DappFence**: **Source-controlled** — the assignment is in a verified script; runtime behaviour of
verified code is outside DappFence's model. `location` is a native object with a non-configurable
`href` setter — client-side patching is not feasible. The external data caveat (see 7a) applies: if
the value assigned to `location.href` comes from attacker-controlled runtime data, that is an
**External data** case.

---

## 4. `<object>` and `<embed>` elements

```html
<object data="/app.swf" type="application/x-shockwave-flash"></object>
<embed src="/plugin.pdf" type="application/pdf" />
```

The browser (or a browser plugin) fetches the resource, and the plugin's scripting engine may
execute code. For PDFs, Acrobat JavaScript can call back into the browser. Flash used
`ExternalInterface.call()` to invoke JavaScript. Both are legacy; modern browsers have dropped most
plugin support.

**CSP**: `object-src` directive controls these. Setting `object-src 'none'` eliminates the vector
entirely.

**DappFence**: **SW intercept** for the resource fetch. The plugin-internal script is opaque to
DappFence once the binary is handed to the plugin. Blocking the resource at the SW level if the hash
doesn't match prevents execution entirely.

---

## 5. SVG

SVG has its own `<script>` element. Execution context depends on how the SVG is loaded.

| Load method                         | Scripts run?              | DappFence                                                                                                    |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Inline `<svg><script>` in HTML      | Yes, same context         | **HTML doc** (static) / **#scripts** tokenizer extraction (SSR) — catches `<script>` anywhere in byte stream |
| `<svg><a xlink:href="javascript:">` | Yes, on click             | **HTML doc** (static) / **#handlers** tokenizer extraction (SSR) — `xlink:href` checked alongside `href`     |
| `<svg on*="...">` event handlers    | Yes, on event             | **HTML doc** (static) / **#handlers** tokenizer extraction (SSR)                                             |
| `<img src="...svg">`                | No                        | N/A                                                                                                          |
| `<object data="...svg">`            | Yes, own browsing context | **SW intercept**                                                                                             |
| `<iframe src="...svg">`             | Yes, own browsing context | **SW intercept**                                                                                             |
| Direct navigation                   | Yes, own browsing context | **SW intercept**                                                                                             |

For inline SVG, the `<script>` text is part of the HTML body, see 1b. SVG `xlink:href` is covered by
the same `#handlers` extraction as section 3a — the tokenizer checks every `xlink:href` attribute
value for a `javascript:` prefix on all elements.

---

## 6. XSLT

### 6a. `XSLTProcessor` (standard)

```javascript
const xslt = new XSLTProcessor();
xslt.importStylesheet(doc); // doc fetched separately
const result = xslt.transformToFragment(source, document);
```

XSLT itself does not contain executable JavaScript. However, the transformation can produce HTML
including `<script>` elements that execute when inserted into the DOM via
`document.body.appendChild(result)`.

**DappFence**: The XSLT file is fetched → **SW intercept**. The scripts produced by the
transformation are inline text nodes injected into the DOM → they execute, but the content
originates from the (verified) XSLT, not a new fetch.

### 6b. `<msxsl:script>` (IE only, legacy)

Embeds JScript directly in the XSLT stylesheet. Executes during transformation.

**DappFence**: **SW intercept** of the XSLT fetch. Dead vector in modern browsers.

### 6c. Firefox `xsl:script` (removed)

Was available in older Firefox builds. Removed. Historical reference only.

---

## 7. Dynamic evaluation APIs

These all execute arbitrary code from a string without a network request.

### 7a. `eval()`

```javascript
eval('malicious()');
```

**CSP**: blocked by `'unsafe-eval'` being absent. `strict-dynamic` does not help here.

**DappFence**: **Source-controlled** no fetch fires. If the string passed to `eval` is part of the
verified script's own logic, this is the developer's runtime behaviour and outside DappFence's
model. The risk arises only when the string originates from an external source (e.g., `postMessage`,
URL parameters, `localStorage`, a `fetch()` response), see **External data** category. In that case,
DappFence confirmed the _script_ was not tampered with but cannot verify the _data_ the script
processes at runtime. Static analysis of the verified scripts is required to detect this pattern.

---

### 7b. `new Function()`

```javascript
const f = new Function('return malicious()');
f();
```

Equivalent to `eval` in terms of CSP and verification. The `Function` constructor is a common
eval-equivalent bypass.

**DappFence**: **Source-controlled** same situation as `eval()`. See 7a.

---

### 7c. `setTimeout` / `setInterval` with string argument

```javascript
setTimeout('malicious()', 1000);
setInterval('doThing()', 500);
```

The string form invokes an implicit `eval`.

**CSP**: blocked by absence of `'unsafe-eval'`.

**DappFence**: **Source-controlled** same situation as `eval()`. See 7a.

---

### 7d. `document.write()` with script injection

```javascript
document.write('<script src="/x.js"></script>');
document.write('<script>malicious()</script>');
```

`src`-bearing scripts injected this way do generate a fetch. Inline text does not.

**CSP**: `'unsafe-inline'` required for the `document.write` call itself if it comes from an inline
handler; the injected `<script>` is subject to normal `script-src` rules.

**DappFence**: injected `<script src>` → **SW intercept**. Injected inline script text →
**Source-controlled**, the string being written is part of the verified script's own logic. See 7a
for the external data caveat.

---

## 8. Workers and Worklets

Workers run JavaScript in a separate thread. Each has its own global scope and event loop.

### 8a. Dedicated Web Worker (URL)

```javascript
const w = new Worker('/worker.js');
```

The browser fetches the worker script.

**DappFence**: **SW intercept** the fetch for `/worker.js` passes through the SW. The worker's own
`importScripts()` calls also fire fetch events and are intercepted.

Browsers require dedicated workers to be same-origin or CORS-enabled, a cross-origin worker URL
without CORS headers fails at the network level before reaching the SW. Opaque worker responses
therefore do not occur in practice, and no empty-stub neutralization is needed for
`destination === "worker"`.

---

### 8b. Dedicated Web Worker (Blob URL)

```javascript
const blob = new Blob(['malicious()'], { type: 'text/javascript' });
const w = new Worker(URL.createObjectURL(blob));
```

No network fetch. The JS content is created entirely in-memory.

**DappFence**: **Source-controlled** no fetch event fires. The blob content is constructed by the
verified script itself; if that script is unmodified, the worker code is the developer's own. Same
model as `eval()` (see 7a): the risk is external data flowing into the blob content, not the pattern
itself.

---

### 8c. Shared Worker

```javascript
const sw = new SharedWorker('/shared.js');
```

Fetched once, shared across pages of the same origin.

**DappFence**: **SW intercept** same as 8a.

---

### 8d. Service Worker (app's own)

```javascript
navigator.serviceWorker.register('/app-sw.js');
```

DappFence intercepts this registration at the client side by monkey-patching
`navigator.serviceWorker.register`. The app SW is loaded via `importScripts()` inside DappFence's
own SW, where it is verified before execution.

**DappFence**: **SW monkey-patch** covered by existing DappFence architecture.

---

### 8e. `importScripts()` inside a Worker/SW

```javascript
// inside a worker or SW
importScripts('/lib.js');
```

Synchronously fetches and evaluates one or more scripts.

**DappFence**: **SW intercept** for scripts fetched by app workers. For the app SW specifically,
DappFence monkey-patches `importScripts` to intercept calls and verify content before execution.

---

### 8f. Worklets (AudioWorklet, PaintWorklet, LayoutWorklet, AnimationWorklet)

```javascript
audioCtx.audioWorklet.addModule('/processor.js');
CSS.paintWorklet.addModule('/painter.js');
```

Worklet modules are fetched by URL and run in a restricted execution context. They cannot import
other modules but do execute JavaScript.

**CSP**: governed by `script-src` (paint/layout/animation worklets) or `worker-src` (AudioWorklet).

**DappFence**: **SW intercept** for network URLs. Blob URL worklet modules are **Source-controlled**
same as 8b.

---

## 9. Dynamic ES module system

### 9a. Dynamic `import()`

```javascript
const mod = await import('/module.js');
```

Fetches and evaluates the module, respecting CORS and CSP.

**DappFence**: **SW intercept** every dynamic import fires a fetch event. Transitive static imports
of that module also fire fetch events.

---

### 9b. Import maps

```html
<script type="importmap">
    { "imports": { "lodash": "/vendor/lodash.js" } }
</script>
```

Remaps bare specifiers to URLs. The actual fetch happens when the remapped module is imported.

**DappFence**: The importmap JSON is **HTML doc** on static routes (covered by document hash). The
remapped module URLs are fetched → **SW intercept** (unknown URLs fail the manifest check).

**On SSR routes the importmap content is covered by the `#importmap` tokenizer extraction (same pass
as `#handlers`).** The `inline-script` extractor explicitly skips `type="importmap"` but the
tokenizer collects it separately. An attacker can inject a remap that redirects a bare specifier
(e.g., `"react"`) to an attacker-controlled URL. The SW blocks unknown URLs, but remapping to an
already-manifest-listed URL (e.g., redirecting `"react"` to `/app.js`) passes undetected — the SW
verifies the hash of the wrong module and passes it through with no violation signal. An attacker
with read-access to the manifest (a public signed document) can list every listed URL and craft a
targeted remap with no new external dependency. `#importmap` verification closes this entirely: any
injected or modified importmap produces a hash not in the manifest → violation.

**Mitigation: same tokenizer pass as `#handlers`.** The tokenizer pass (see section 2) collects the
raw text content of every `<script type="importmap">` element and hashes it against a
`pageKey + "#importmap"` manifest entry. All three extractions — `#scripts`, `#handlers`, and
`#importmap` — happen in the same single post-fetch phase with no additional parsing cost.

---

## 10. `data:` and `blob:` URIs as script sources

### 10a. `data:` URI in `<script src>`

```html
<script src="data:text/javascript,alert(1)"></script>
```

Blocked by all major modern browsers at the engine level regardless of CSP (Chrome 68+, Firefox,
Safari). Was a classic CSP bypass in older browsers.

**CSP**: `data:` is not implicitly allowed in `script-src`; must be explicitly listed. Browser
enforcement is the primary barrier; CSP is a secondary layer.

**DappFence**: **Browser-blocked** — no fetch event fires for `data:` URIs; engine-level enforcement
in all modern browsers makes this dead. For SSR routes, the tokenizer extraction phase detects an
unexpected `<script src="data:...">` as an unrecognised `#scripts` entry, providing defense-in-depth
even though browser execution is already blocked.

---

### 10b. `data:text/html` iframe

```html
<iframe src="data:text/html,<script>parent.steal()</script>"></iframe>
```

The iframe has a null (opaque) origin. In modern browsers (Chrome 80+, Firefox, Safari), `data:`
iframes are assigned a unique opaque origin — direct DOM access to the parent (`parent.steal()`)
throws a cross-origin `SecurityError`. The `document.domain` setter that older browsers used to
bridge origins is deprecated and no-ops in current engines.

**CSP**: blocked by `frame-src` if `data:` is not listed.

**DappFence**: **Browser-mitigated** — no fetch event fires for the iframe content; direct DOM
access is blocked by the null-origin restriction in modern browsers.

The **real residual concerns** are narrower:

-   **Parent navigation**: cross-origin frames can still write to `parent.location.href`, navigating
    the parent page away. This does not execute arbitrary script in the parent but can redirect
    users to an attacker-controlled page.
-   **`postMessage` chaining**: a null-origin iframe can call `parent.postMessage(payload, '*')`. If
    the parent has any `message` listener that does not check `event.origin` and passes data to an
    eval-equivalent API, this chains into the 16b (External data) vector.

For SSR routes, the tokenizer extraction phase detects an injected `<iframe src="data:...">` — the
`#handlers` check flags `src` attributes on `<iframe>` and `<frame>` that begin with `data:`.

---

### 10c. Blob URL iframe or script

```javascript
const html = '<script>parent.steal()</script>';
const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
const iframe = document.createElement('iframe');
iframe.src = url;
```

**DappFence**: **Source-controlled** blob: URLs are served from an in-memory store; no fetch event
fires. The blob content is constructed by a verified script; same model as 8b and 7a. The blob:
origin is the creating origin, so the inner script has same-origin access, making the external data
issue (see 7a) particularly relevant here.

---

## 11. CSS execution contexts

### 11a. IE `expression()` (legacy)

```css
div {
    width: expression(document.cookie);
}
```

CSS expressions evaluated arbitrary JavaScript during style recalculation. Removed in IE8 Standards
Mode. Dead vector.

**DappFence**: **SW intercept** of the stylesheet fetch. Dead in modern browsers.

---

### 11b. IE `behavior:` / HTC files (legacy)

```css
div {
    behavior: url(/component.htc);
}
```

HTC (HTML Component) files could contain `<script>` that ran in the element's context. IE only, long
removed.

**DappFence**: **SW intercept** of the HTC fetch. Dead in modern browsers.

---

### 11c. CSS Houdini Worklets

```javascript
CSS.paintWorklet.addModule('/paint.js');
CSS.layoutWorklet.addModule('/layout.js');
```

See 8f above. Worklets are JavaScript executed in response to CSS paint/layout.

---

## 12. DOM script element injection

### 12a. createElement + src (network)

```javascript
const s = document.createElement('script');
s.src = '/evil.js';
document.head.appendChild(s);
```

When the element is attached to the document, the browser fetches the URL.

**DappFence**: **SW intercept** the fetch fires through the SW handler.

---

### 12b. createElement + textContent (inline)

```javascript
const s = document.createElement('script');
s.textContent = 'malicious()';
document.head.appendChild(s);
```

No fetch. The text is executed inline.

**DappFence**: **Source-controlled** no fetch event. The text assigned is part of the verified
script's own logic. See 7a for the external data warning.

---

### 12c. `innerHTML` injection

```javascript
element.innerHTML = '<script>malicious()</script>';
```

Modern browsers do **not** execute scripts injected via `innerHTML` (by spec). This is a common
misconception, the `<script>` is parsed into the DOM but the browser's HTML parser marks it as
already-started and skips execution.

**DappFence**: N/A scripts injected this way do not execute. Note: `<img onerror>` and other
event-handler elements inserted via `innerHTML` **do** fire. Those are covered as event handlers
(section 2).

---

## 13. WebAssembly

```javascript
const resp = await fetch('/module.wasm');
const { instance } = await WebAssembly.instantiateStreaming(resp);
instance.exports.run();
```

WASM modules are fetched, compiled, and executed. Exported functions are callable from JavaScript.
Imported JavaScript functions can be called back from WASM.

**CSP**: `script-src` with `'wasm-unsafe-eval'` (or `'unsafe-eval'` in older browsers).

**DappFence**: **SW intercept** for the `fetch()` call. The SW intercepts the response before it is
handed to `instantiateStreaming`, so the binary can be hashed and verified. For
`WebAssembly.instantiate(buffer)` where the buffer was obtained without a tracked fetch:
**Source-controlled** the buffer was produced by a verified script. See 7a for the external data
warning.

---

## 14. PDF JavaScript

PDF files may contain JavaScript (Acrobat JS). When rendered by the browser's native PDF renderer or
via PDF.js, embedded scripts can execute.

**CSP**: no directive covers PDF-embedded scripts specifically. `object-src 'none'` prevents
`<object>`/`<embed>` loading, but inline `<iframe>` PDF rendering bypasses this.

**DappFence**: **SW intercept** of the PDF fetch. What the PDF reader does with the binary afterward
is opaque. Verifying the hash of the PDF file ensures the file itself hasn't been tampered with but
cannot inspect the JS within it without parsing.

---

## 15. Legacy and environment-specific vectors

### 15a. VBScript

```html
<script language="vbscript">
    MsgBox "hello"
</script>
```

IE only. Removed in Edge. Dead vector.

**DappFence**: **HTML doc** (inline). Dead in modern browsers.

---

### 15b. IE conditional comments

```html
<!--[if IE]><script src="/ie-only.js"></script><![endif]-->
```

Parsed only by IE; ignored by other browsers as an HTML comment.

**DappFence**: **SW intercept** for the script URL if on IE. Dead in modern browsers.

---

### 15c. `<link rel="import">` (HTML Imports, deprecated)

```html
<link rel="import" href="/component.html" />
```

Google Chrome shipped HTML Imports; imported documents could contain `<script>` tags that executed
in the importing document's context. Removed from Chrome in 2020.

**DappFence**: **SW intercept** of the HTML import fetch. Dead in modern browsers.

---

## 16. Indirect / surprising vectors

### 16a. JSONP

```javascript
const s = document.createElement('script');
s.src = 'https://api.example.com/data?callback=process';
document.head.appendChild(s);
```

The server responds with `process({...})` arbitrary JavaScript executed in the page context.

**DappFence**: JSONP has two compounding problems. First, the script URL is cross-origin with no
CORS headers, the SW CORS retry fails, and DappFence returns an empty stub. The JSONP callback never
executes. Second, even if the CDN added CORS headers, JSONP responses are generated dynamically
per-request and cannot be pre-hashed; there is no fixed content to record in the manifest.

There is no `allow` rule path here. A JSONP endpoint under an `allow` rule would unconditionally
execute whatever the server returns with no verification, a perfect DNS hijacking or
server-compromise target. JSONP is inherently incompatible with content integrity verification. The
correct response is to replace it with a CORS-enabled JSON API and move any execution logic into a
verified static script. Using DappFence is a forcing function to eliminate JSONP from the
application.

---

### 16b. `postMessage` + `eval`

```javascript
window.addEventListener('message', (e) => eval(e.data));
```

An external window/worker sends a message whose content is `evaled`. No fetch.

**DappFence**: **External data** the `addEventListener` registration is in a verified script, but
the message payload arrives from an external origin at runtime and is passed directly into `eval`.
This is the canonical external data case: DappFence confirmed the handler script was not tampered
with, but the executed code was never verified. Static analysis of the verified scripts is required
to detect this pattern.

---

### 16c. `<base href="javascript:">` + form submit

```html
<base href="javascript:" />
<form action="/path"><input type="submit" /></form>
```

In some older browsers, relative URL resolution against a `javascript:` base could produce a
`javascript:` action. Largely mitigated in modern browsers.

**DappFence**: **HTML doc** the `<base>` tag is in the HTML.

---

### 16d. `<meta http-equiv="refresh">` to `javascript:` URL

```html
<meta http-equiv="refresh" content="0; url=javascript:alert(1)" />
```

Blocked in modern browsers (Chrome, Firefox ignore `javascript:` in meta-refresh). Historical
vector.

**DappFence**: **HTML doc** the meta tag is in the HTML.

---

### 16f. `<template>` with cloneable scripts

```html
<template id="t">
    <script>
        malicious();
    </script>
</template>
<script>
    document.body.appendChild(document.getElementById('t').content.cloneNode(true));
</script>
```

`<template>` content is parsed into an inert DocumentFragment — scripts inside do not execute when
the template is parsed. However, when JavaScript clones the template content into the live document,
any `<script>` elements inside execute immediately.

A compromised server can inject a `<script>` inside an existing `<template>` element knowing that
the framework's own verified JavaScript will clone it. The injected script is never fetched (no SW
intercept), and the `<template>` wrapper causes a naive extractor to skip it.

**DappFence**: The tokenizer has no special `<template>` handling — it extracts `<script>` content
from every element in the byte stream, including inside `<template>`. Any script found inside a
`<template>` that does not appear in the path's `#scripts` manifest entry is a violation. If a
developer legitimately uses `<template>` with known static script content, those hashes must be
added to the manifest. If the `<template>` content is dynamic, it should not contain `<script>`
elements — use event listeners in the cloning code instead.

**CSP**: nonce/hash on the cloned `<script>` would be required under strict CSP, but the nonce
changes per request and cannot be pre-committed. This is another reason not to use inline `<script>`
inside `<template>` in SSR contexts.

---

### 16e. `<link rel="preload" as="script">` + dynamic append

```html
<link rel="preload" href="/deferred.js" as="script" />
```

Preloads the resource but does not execute it. A later `<script src="/deferred.js">` picks it from
the preload cache without a new fetch.

**DappFence**: **SW intercept** fires on the preload fetch. The response is verified and cached at
that point. The subsequent execution uses the cached (already verified) response.

---

## 17. SSR inline-content verification

### The problem

DappFence's baseline verification hashes entire response bodies against the manifest. For static
HTML this is straightforward, the file is known at build time. For SSR routes the HTML body changes
per request, so no stable document hash exists. The manifest-rules design addresses this with two
complementary mechanisms, each targeting a different class of injected content.

### Mechanism 1 Inline script verification (`#scripts`)

The SW extracts every `<script>` element without a `src` attribute from the HTML response (keeping
`type` absent, `text/javascript`, or `module`; skipping `importmap` and data islands). Each
extracted script is hashed and checked against `files[pageKey + "#scripts"]` as a set-membership
test. This runs as an independent post-fetch phase, even when an `allow` contentRule skips the
document body hash for an SSR route, `#scripts` verification still fires.

```json
"contentRules": [
{
"condition": {"resourceTypes": ["document"], "urlFilter": "/dashboard"},
"action": {"type": "allow"}
},
{
"condition": {"resourceTypes": ["inline-script"]},
"action": {"type": "verify"}
}
],
"files": {
"/dashboard#scripts": ["sha256-hydration-bootstrap", "sha256-config-init"]
}
```

An attacker who injects a new `<script>` block into the SSR response will produce a hash that is not
in the `#scripts` set → violation. **This covers vectors 1b and 1d (inline scripts and inline module
entries) on SSR routes**, provided the inline scripts are static and known at build time (true for
most SSR framework output).

### Mechanism 2 Document body hash (static routes)

For fully static HTML the document body itself is hashed and verified, which transitively covers
every byte in the page: inline scripts, event handler attributes, `javascript:` hrefs, import maps,
and anything else embedded in markup.

### What each mechanism covers on SSR

| Vector                                     | Static                      | SSR                                                             |
| ------------------------------------------ | --------------------------- | --------------------------------------------------------------- |
| Inline `<script>` (1b)                     | Document hash               | `#scripts` tokenizer extraction ✓                               |
| Inline `<script type="module">` (1d)       | Document hash               | `#scripts` tokenizer extraction ✓                               |
| New `<script src>` injected by server (1a) | SW intercept fails manifest | SW intercept fails manifest ✓                                   |
| `on*` event handler attributes (2)         | Document hash               | `#handlers` tokenizer extraction ✓                              |
| `javascript:` hrefs / actions (3a)         | Document hash               | `#handlers` tokenizer extraction ✓ (incl. `xlink:href`)         |
| Inline SVG `<script>` (5)                  | Document hash               | `#scripts` tokenizer extraction ✓ (catches `<script>` anywhere) |
| `<script>` inside `<template>` (16f)       | Document hash               | `#scripts` tokenizer extraction ✓ (template not skipped)        |
| `<script type="importmap">` (9b)           | Document hash               | `#importmap` tokenizer extraction ✓                             |

### Pending SSR coverage

No classes remain unaddressed. The tokenizer extraction phase covers all four vectors in a single
post-fetch pass.

**Current outside-DappFence controls (not a substitute):**

-   CSP with `'unsafe-inline'` absent blocks inline event handlers and `javascript:` hrefs at the
    browser level. CSP is a separate defense layer and does not feed back into DappFence's violation
    reporting.
-   Modern SSR frameworks (Next.js, Astro) generally do not emit `on*` attributes or `javascript:`
    hrefs in generated HTML. This reduces the practical surface but provides no technical guarantee
    a compromised server can emit anything.

**The CSP dependency is weaker than it looks.** CSP delivered via HTTP headers is reliable headers
require server cooperation to forge. However, CSP can also be set via
`<meta http-equiv="Content-Security-Policy" ...>` in the HTML body. If an attacker controls the SSR
response, they can inject a meta-tag that overrides or weakens the CSP before the `on*` handler
fires. Browser behavior on conflicting header + meta CSP varies, but meta-delivered CSP is accepted
by all major engines. Relying on CSP to close the SSR `on*` and `javascript:` gaps therefore
requires CSP to be delivered exclusively via HTTP headers, never via meta-tag, and the header policy
to be applied unconditionally by the server regardless of the response body.

**The `#scripts` mechanism assumes inline scripts are static at build time.** If an SSR framework
embeds any per-request state into a `<script type="text/javascript">` block (not a
`type="application/json"` data island, which is skipped), the hash of that script changes per
request. Every page load produces a script hash not in the manifest → constant violations. Operators
must ensure that framework-injected inline scripts (hydration bootstraps, config embeds, RSC
payloads) either use `type="application/json"` (skipped by the extractor) or are fully static. This
assumption should be validated against each framework's output during integration, not assumed.

**Implementation:**

All extraction runs in a single post-fetch tokenizer pass. The tokenizer is a purpose-built
byte-level state machine bundled into `dappfence.js` and shared with the build-time integration
packages (`@dappfence/astro`, `@dappfence/next`) via `@dappfence/manifest-tools`. Both sides use
identical extraction logic, which guarantees hash alignment between what the manifest records at
build time and what the SW computes at runtime.

**1. `on*` handlers (`#handlers`)** — the tokenizer fires a callback for every opening tag with its
full attribute map. The extraction layer picks every attribute whose name begins with `on`, hashes
the raw value, and checks against `pageKey + "#handlers"`.

**2. `javascript:` attributes (`#handlers`, same entry)** — the same callback checks `href`,
`action`, `formaction`, `xlink:href`, and `src` (on `<iframe>`/`<frame>`) for a `javascript:` prefix
(case-insensitive). Matches are hashed and added to the `#handlers` set.

**3. Import maps (`#importmap`)** — the tokenizer fires a callback for every `<script>` element with
its content and attributes. The extraction layer checks `attrs.type === "importmap"` and hashes the
raw text content against `pageKey + "#importmap"`.

**4. `<template>` content** — the tokenizer has no special `<template>` handling. `<script>`
elements inside `<template>` are extracted identically to those outside it and checked against
`#scripts`.

---

## 18. Tag managers and the DappFence model

Google Tag Manager and similar products (Tealium, Adobe Launch, Segment CDN) are fundamentally
incompatible with DappFence's security model.

Tag managers exist so that non-engineers can inject arbitrary third-party scripts into a page
without code deployments. DappFence requires every script to be enumerated at build time with a
known hash. These constraints are mutually exclusive.

**Why this is an `External data` problem, not just a configuration conflict.** GTM's script
(`gtm.js`) can itself be verified via SW intercept. The incompatibility is not about GTM the file —
it is about what GTM does at runtime: it fetches tag configurations from Google's servers and uses
them to dynamically inject `<script>` elements into the page. Those injected scripts fall into two
categories:

-   **External URL scripts** (e.g., analytics pixels, third-party widgets): fetched as
    `<script src>` → SW intercepts, hash not in manifest → blocked. Providing an `allow` rule gives
    zero integrity protection (see section 1a).
-   **Inline scripts emitted by GTM**: GTM generates `<script>` elements with text content derived
    from tag configuration stored on Google's servers. Even though the GTM script itself was
    verified, the _content_ it injects is runtime data from an external source — the canonical
    **External data** case (see coverage legend). DappFence confirmed GTM wasn't tampered with; it
    cannot verify what GTM writes at runtime.

This means no configuration of allow rules, trust exceptions, or manifest entries can make GTM
compatible. The external data enters at the point where GTM fetches its tag configuration, before
any script runs, and materializes as unverifiable inline or remote script execution.

Deploying DappFence means opting out of tag-manager-style dynamic loading. Scripts that previously
lived in GTM must be handled in one of three ways:

-   **Self-host and add to manifest**: bring the script in-origin, add its hash to the manifest.
    Version updates require a new build and deploy, this is a feature, not a limitation, because it
    means no third party can modify what runs on your page without going through your release
    process.

-   **Load directly with hash verification**: if the vendor's CDN supports CORS, add the script tag
    directly to the app HTML and add the hash to the manifest. The SW CORS retry handles
    verification transparently. The developer must update the manifest hash when the vendor updates
    the script.

-   **Remove**: marketing tags, analytics pixels, and A/B testing scripts that cannot be verified
    represent the exact attack surface DappFence exists to eliminate. Removing them is the correct
    security outcome.

The last point is intentional. A significant fraction of real-world supply chain attacks on web
applications is delivered through compromised analytics and marketing SDKs, the same category of a
script that tag managers inject. DappFence's incompatibility with GTM is not a gap to be bridged; it
is the security property being enforced.

**Analytics alternative**: server-side analytics (sending events from the backend or using a
privacy-focused client-side library that is self-hosted and hash-verified) is compatible with
DappFence. Client-side analytics that require loading a script from a third-party domain are
compatible if the vendor's CDN supports CORS and the hash is stable between updates.

---

## Summary matrix

| #     | Vector                              | Fetch fires? | Static coverage                | SSR coverage                   | Notes                                                                                     |
| ----- | ----------------------------------- | ------------ | ------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------- |
| 1a    | `<script src>` (same-origin)        | Yes          | SW intercept                   | SW intercept                   | Primary case                                                                              |
| 1a    | `<script src>` cross-origin + CORS  | Yes          | SW intercept                   | SW intercept                   | Body accessible; verify against full-URL key                                              |
| 1a    | `<script src>` cross-origin no-cors | Yes          | SW CORS retry → verify or stub | SW CORS retry → verify or stub | SW re-issues as CORS; body accessible if CDN supports CORS; stubs + warns otherwise       |
| 1b    | Inline `<script>`                   | No           | HTML doc                       | #scripts verify                | Requires static inline scripts                                                            |
| 1c    | `<script type=module src>`          | Yes          | SW intercept                   | SW intercept                   | Includes transitive imports                                                               |
| 1d    | Inline module                       | Partial      | HTML doc + SW intercept        | #scripts + SW intercept        | Extractor keeps type=module                                                               |
| 2     | `on*` event handlers                | No           | HTML doc                       | #handlers tokenizer ✓          | All elements incl. SVG/MathML/template; refactor to listeners if not in manifest          |
| 3a    | `javascript:` in markup             | No           | HTML doc                       | #handlers tokenizer ✓          | href/action/formaction/xlink:href/iframe-src; case-insensitive prefix check               |
| 3b    | `location.href = 'javascript:'`     | No           | Source-controlled              | Source-controlled              | Runtime JS from verified script; `location` not patchable                                 |
| 4     | `<object>` / `<embed>`              | Yes          | SW intercept                   | SW intercept                   | Plugin internals opaque                                                                   |
| 5     | SVG via `<object>`/`<iframe>`       | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 5     | Inline SVG `<script>`               | No           | HTML doc                       | #scripts tokenizer ✓           | Tokenizer catches `<script>` anywhere in byte stream incl. inside SVG                     |
| 5     | SVG `xlink:href="javascript:"`      | No           | HTML doc                       | #handlers tokenizer ✓          | Checked alongside href/action/formaction in same pass                                     |
| 5     | SVG `on*` event handlers            | No           | HTML doc                       | #handlers tokenizer ✓          | All opening tags scanned; no element-type exclusion                                       |
| 6     | XSLT                                | Yes          | SW intercept                   | SW intercept                   | Output scripts are inline                                                                 |
| 7a    | `eval()`                            | No           | Source-controlled              | Source-controlled              | External data into eval is an External data case; requires static analysis                |
| 7b    | `new Function()`                    | No           | Source-controlled              | Source-controlled              | Same as eval                                                                              |
| 7c    | `setTimeout(string)`                | No           | Source-controlled              | Source-controlled              | Same as eval                                                                              |
| 7d    | `document.write(<script src>)`      | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 7d    | `document.write(inline script)`     | No           | Source-controlled              | Source-controlled              | String is part of the verified script                                                     |
| 8a    | Worker (URL)                        | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 8b    | Worker (Blob URL)                   | No           | Source-controlled              | Source-controlled              | Blob content generated by verified script; same model as eval                             |
| 8c    | Shared Worker                       | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 8d    | App Service Worker                  | N/A          | SW monkey-patch                | SW monkey-patch                | Existing DappFence feature                                                                |
| 8e    | `importScripts()`                   | Yes          | SW intercept + monkey-patch    | SW intercept + monkey-patch    |                                                                                           |
| 8f    | Worklets                            | Yes          | SW intercept                   | SW intercept                   | Blob URL variant is Source-controlled                                                     |
| 9a    | Dynamic `import()`                  | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 9b    | Import maps                         | Partial      | HTML doc + SW intercept        | #importmap tokenizer ✓         | Remap-to-known-URL bypass closed by #importmap; remapped URLs still SW-intercepted        |
| 10a   | `data:` script src                  | No           | Browser-blocked                | Browser-blocked                | Engine-level block in all modern browsers; tokenizer detects in SSR HTML as unknown entry |
| 10b   | `data:` iframe                      | No           | Browser-mitigated              | Browser-mitigated              | Null-origin blocks direct DOM access; residual: parent navigation + postMessage chaining  |
| 10c   | Blob URL iframe/script              | No           | Source-controlled              | Source-controlled              | Blob created by verified script; same-origin access makes external data caveat critical   |
| 11a-b | CSS expression / HTC                | Yes          | SW intercept                   | SW intercept                   | IE only, dead                                                                             |
| 11c   | CSS Houdini worklets                | Yes          | SW intercept                   | SW intercept                   | Blob URL variant is Source-controlled                                                     |
| 12a   | `createElement` + src               | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 12b   | `createElement` + textContent       | No           | Source-controlled              | Source-controlled              | Text is part of the verified script                                                       |
| 12c   | `innerHTML` injection               | No           | N/A                            | N/A                            | Browsers don't execute                                                                    |
| 13    | WebAssembly (fetch)                 | Yes          | SW intercept                   | SW intercept                   |                                                                                           |
| 13    | WebAssembly (buffer)                | No           | Source-controlled              | Source-controlled              | Buffer produced by verified script                                                        |
| 14    | PDF JavaScript                      | Yes          | SW intercept                   | SW intercept                   | Binary contents opaque                                                                    |
| 15a-c | VBScript / IE / HTML Imports        | Partial      | N/A (legacy, dead)             | N/A (legacy, dead)             | Dead vectors; removed from all modern browsers                                            |
| 16a   | JSONP                               | Yes          | SW CORS retry fails → stub     | SW CORS retry fails → stub     | Dynamic content, not pre-hashable; no allow rule path must be replaced                    |
| 16b   | `postMessage` + `eval`              | No           | External data                  | External data                  | Handler script verified; payload from external origin is not                              |
| 16d   | meta-refresh `javascript:`          | No           | HTML doc                       | Browser-blocked                | Blocked in modern browsers                                                                |
| 16e   | preload + append                    | Yes          | SW intercept                   | SW intercept                   | Verified on preload                                                                       |
| 16f   | `<template>` cloneable scripts      | No           | HTML doc                       | #scripts tokenizer ✓           | Template not skipped; scripts inside extracted same as any other inline script            |
