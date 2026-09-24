# CSP Injection Strategy

The canonical design for what DappFence verifies and how it composes with CSP lives in
`docs/verification-cases.md`. This document is the CSP-specific slice: what header the SW emits, how
it treats the origin's header, and why.

## Trust model summary

Per `docs/verification-cases.md` § "The trust model":

-   The signed manifest is the **sole runtime source of truth for CSP**.
-   Any `Content-Security-Policy` (and `Content-Security-Policy-Report-Only`) header the origin
    emits is **untrusted** — the attacker with server control writes it.
-   Any nonce the origin emits is **untrusted** — the attacker mints matching ones.
-   Any inline `<script>` the origin serves is **untrusted** unless the SW verifies its body against
    a signed skeleton.

Two rules follow directly:

1. **The SW replaces the origin's CSP header wholesale.** Not filters, not appends. Anything from
   the origin is discarded; the header the browser enforces is derived entirely from the signed
   manifest.
2. **Origin nonces never propagate into the SW's CSP.** Where a nonce is used, it is SW-generated
   per response (see § Nonce-based delivery, planned).

### Why "just strip nonces from the origin header" is not enough

A tempting simpler rule: leave the origin CSP intact, strip only `'nonce-…'` tokens. This fails
because:

-   `'unsafe-inline'` / `'unsafe-eval'` / origin-listed hashes in `script-src` remain enforced.
    Attacker adds these to allowlist their own inline payload.
-   `report-uri` remains attacker-controlled — violation telemetry leaks to the attacker.
-   Multiple CSP headers are enforced _independently_ (intersection per directive). For any
    directive we don't emit (`frame-ancestors`, `form-action`, `base-uri`, `frame-src`), whatever
    the origin sets binds. The delta is the bypass surface.
-   The filter list would need to grow with every new CSP feature. Full replacement is one invariant
    vs. an ever-growing filter.

## Emitted policy

The SW-emitted CSP is derived from the signed `manifest.csp` section only. Base directives, no
manifest data required:

```
default-src     'none';
script-src-attr 'none';
object-src      'none';
base-uri        'none';
frame-ancestors 'none';
worker-src      'self';       // required — DappFence registers its own SW
style-src       'self' 'unsafe-inline';
img-src         'self' data:;
font-src        'self';
```

Manifest-driven directives:

```
script-src-elem 'sha256-…' *;            // inline hashes from manifest.csp.pages, external via *
connect-src     'self' <manifest.csp.connectOrigins>;
report-uri      /sw-api/csp-violation?token=<api-token>;
```

Notes on individual directives:

-   **`script-src-elem`** uses `*` for external scripts because the SW already verifies every
    external script by content hash at fetch time — restricting by origin in CSP adds no security
    benefit. Inline scripts are gated by manifest-listed hashes (current implementation) or by
    SW-generated nonce (planned; see § Nonce-based delivery).
-   **`'strict-dynamic'`** is intentionally absent. It is incompatible with the `*` wildcard, and
    the external-script trust it would otherwise propagate is already covered by SW-level
    verification.
-   **`style-src 'unsafe-inline'`** is safe: all CSS JS-execution vectors (`expression()`,
    `behavior:`, HTC) are IE-only and dead in modern browsers — see `docs/js-execution-vectors.md`
    § 11.
-   **`worker-src 'self'`** cannot be tightened portably. The browser already enforces same-origin
    for service workers regardless of CSP, so `'self'` adds no new trust.
-   **`report-uri`** — the DappFence violation-report endpoint. `report-uri` is deprecated in favor
    of `report-to` + `Reporting-Endpoints`, but the newer API's SW-interception behavior varies
    across browsers; `report-uri` remains the load-bearing mechanism.

## Header replacement — implementation shape

Current code (`packages/dappfence/src/sw/response.js`) treats CSP as **additive**: the SW appends
its policy alongside the origin's. That was correct under the "defense in depth" framing but is
wrong under the current trust model — it leaves origin directives we don't override enforceable.

Direction: the SW's header injection path must **delete** any incoming `Content-Security-Policy` and
`Content-Security-Policy-Report-Only` headers from the response before setting its own. Concretely,
the `ADDITIVE_HEADERS` set is replaced with a **strip-then-set** rule for these two headers; other
additive headers (`Permissions-Policy`, `Reporting-Endpoints`, `Report-To`) can keep append
semantics for now — they will get the same treatment in a follow-up.

## Hash-based inline delivery (current implementation)

For build-time-stable inline scripts, `manifest.csp.pages[pageKey]` lists SHA-256 hashes of the
`<script>` body and `on*` attribute values. The SW emits them in `script-src-elem` /
`script-src-attr`.

**`csp.pages` shape:**

```json
"csp": {
  "pages": {
    "/dashboard": {
      "scripts": ["sha256-<inline-script-hash>"],
      "attrs":   ["sha256-<onclick-handler-hash>"]
    }
  }
}
```

Each hash in `attrs` is the SHA-256 of the raw attribute value text, exactly as it appears between
the quotes in an HTML source, before any entity decoding. `@dappfence/manifest-tools`'
`extractInlineScriptHashes(htmlPath)` and `extractInlineAttrHashes(htmlPath)` produce these at build
time.

### `'unsafe-hashes'` is required for `script-src-attr`

Event-handler hashes only apply when `'unsafe-hashes'` is present in `script-src-attr`. Without it,
the browser silently ignores the hashes and blocks all handlers. DappFence emits `'unsafe-hashes'`
automatically whenever `attrs` is non-empty; it is never emitted without accompanying hashes.

**Security caveat — prefer `addEventListener`.** `'unsafe-hashes'` lets the browser execute the
handler on any element whose attribute value matches a declared hash — including one an attacker
injected. If HTML injection is possible on a route (i.e., anywhere the body is not byte-hashed), the
attacker can clone the attribute onto a decoy element and trigger execution on user click.
`addEventListener` inside a hash-allowlisted `<script>` block is element-bound and not hijackable.

## Nonce-based delivery — direction, next step, and abandoned alternative

**First step.** SW generates a fresh nonce N per response, emits `script-src-elem 'nonce-N' *`, tags
only its own bootstrap script with N. Every other inline that reaches the browser is un-nonced and
blocked. Per-request state that today ships as inline `<script>` (RSC push chunks,
`window.__STATE__ = …`, framework hydration payloads) has to be refactored by the app into inert
`<script type="application/json">` data islands (read with `JSON.parse(el.textContent)` — see
`docs/verification-cases.md` § "Client consumption patterns" pattern 3). Data blocks are not
scripts, so CSP doesn't gate them; the SW only needs to byte-hash their bodies where the manifest
declares them stable. External scripts pass CSP via `*` and are hash-verified by the SW at fetch
time.

**Next step (planned) — targeted RSC parser.** The SW streams response bodies, identifies
`<script>self.__next_f.push(…)</script>` boundaries, hands each body to a narrow RSC wire-format
parser, verifies the payload against a per-route manifest entry, and applies `nonce=N` iff verified.
Aimed at Next.js RSC apps whose per-request inline is the RSC push wire — the highest- value
framework target — without generalising to "verify every framework shape." Once shipped,
`docs/verification-cases.md` Cases 6/7/20-Pattern-C/21 become compatible.

**Skeleton verification (general-shape parser) was considered and abandoned** (2026-06-25). Not to
be confused with the planned RSC parser. The retired design covered per-shape verification for
_every_ framework inline shape (RSC push, `window.<name>` assignments, Astro island init, JSON
island position, importmap validation, and so on). The mechanism worked on paper; the cost of
shipping a streaming HTML tokenizer plus per-shape parsers plus a manifest schema for skeletons plus
variant enumeration for bounded conditionals was judged higher than the developer cost of the
data-island refactor. The forcing function is the point: apps that can't refactor don't work with
DappFence, which is a load-bearing property, not a limitation to paper over. The design below is
retained for historical context — the same problem statement (per-request inline can't be
pre-hashed) will resurface if anyone re-opens the question.

### Skeleton verification (retired design)

The hash approach only works for build-time-stable inline scripts. Per-request scripts (RSC push
chunks, per-request `window.__STATE__` assignments, framework hydration payloads) cannot be
pre-hashed. The retired mechanism:

1. SW generates a fresh unpredictable nonce N per response, before body streams.
2. SW commits CSP with `script-src 'nonce-N'` in the header.
3. SW streams the response body through an HTML tokenizer, identifies `<script>` element boundaries.
4. For each `<script>`, the SW verifies the body against the manifest's skeleton for the route:
    - Build-time-stable body → byte-exact match against a listed hash.
    - Per-request body → structural skeleton and dynamic-leaf heuristics
      (`window.<name> = <literal>`, RSC Flight-protocol tree, Astro server-island init, JSON
      island).
5. Verified → SW writes `nonce=N` on the element. Unverified → no nonce → browser blocks.

Under this mechanism, CSP `script-src` **does not list hashes** for per-request scripts — the nonce
is the gate; the SW's per-element verification is the trust root. Byte-hash listing of
build-time-stable scripts stays available as a defense-in-depth option but is redundant with
verification-then-nonce.

### First-step scope

Rolling out the current direction is straightforward — no tokenizer, no per-shape parsers, no
skeleton schema:

1. Add header-strip behavior for origin CSP.
2. Emit `script-src-elem 'nonce-N' *` with a per-response SW-generated N; tag only the bootstrap
   with N. Keep the manifest's `csp.pages` byte-hashes as an optional defense-in-depth allowlist for
   build-time-stable inline scripts.
3. Accept that per-request inline scripts stay blocked — including Next.js RSC's
   `self.__next_f.push(…)` blocks — until the app refactors to JSON data islands.

**Next.js RSC (`force-dynamic`) will break** in this state. That is the intended outcome under the
forcing-function principle: the fix is to refactor the app to serialize state into data islands, not
to reintroduce per-request-body verification in the SW. The `dynamicRSC` re-execution mode described
in earlier drafts of this doc is retired.

## What CSP alone closes

Even before the streaming rewriter lands, the SW's CSP closes several vectors without any HTML
parsing:

| Vector                                             | Directive that closes it                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `on*` inline event handler attributes              | `script-src-attr 'none'` (or hash-allowlist with `'unsafe-hashes'`) |
| `eval()` / `new Function()` / `setTimeout(string)` | absence of `'unsafe-eval'`                                          |
| Static inline `<script>` blocks not in manifest    | absence of `'unsafe-inline'` in `script-src-elem`                   |
| `<object>` / `<embed>`                             | `object-src 'none'`                                                 |
| WebAssembly compile from origin bytes              | absence of `'wasm-unsafe-eval'`                                     |
| `data:` / `blob:` script `src`                     | not listed in `script-src-elem`                                     |
| `<base href>` hijack (relative-URL redirection)    | `base-uri 'none'`                                                   |
| `javascript:` URLs in `<a>`, `<iframe>`, etc.      | absence of `'unsafe-inline'` (falls back to `default-src 'none'`)   |
| Framing / clickjacking                             | `frame-ancestors 'none'`                                            |

## CSP violation reporting

The SW's CSP always sets `report-uri /sw-api/csp-violation?token=<api-token>`. The report endpoint
is same-origin and within SW scope, so browser-generated violation POSTs fire an SW fetch event with
`event.clientId` set to the violating page.

```
CSP blocks script (browser, synchronous)
  → browser POSTs violation report to /sw-api/csp-violation
    → SW fetch event fires (event.clientId = violating page)
      → SW validates api-token, logs and stores violation (telemetry only —
        browser has already blocked execution)
```

The `?token=` parameter rejects unauthenticated POSTs. Without the token, a compromised origin could
forge violation reports to poison DappFence's telemetry.

`Content-Security-Policy-Report-Only` is available for staging rollouts but should be treated the
same as the enforcing header: origin-emitted values are discarded; the SW emits its own if a
report-only rollout is configured.

## Framework compatibility (current CSP posture — first step)

| Framework mode                                  | Coverage under first-step CSP (hash-based, no nonce)                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Astro static (`output: 'static'`)               | Full — inline scripts hashed at build time                                     |
| Astro SSR without server islands                | Works if inline scripts are stable across renders; integration must assert     |
| Astro server islands (Case 10)                  | Requires streaming rewriter — per-request init script cannot be hashed         |
| Next.js Pages Router                            | Full — `__NEXT_DATA__` is `type="application/json"`, not subject to script-src |
| Next.js App Router SSG / ISR                    | Works when RSC payload is served as a separate `.rsc` file (not inline)        |
| Next.js App Router `force-dynamic` (RSC inline) | **Breaks** — waits for streaming rewriter                                      |

## First-load bootstrap — the CSP TOFU window

On the very first visit ever to the origin (SW not yet installed for this origin in this browser
profile), our SW is not registered. The browser fetches the HTML directly from the origin, and
whatever CSP the origin emits — or nothing — is what the browser enforces for that document.
DappFence cannot inject a CSP header for a response the SW does not intercept.

Even once the first page's `<script src="/dappfence.js">` runs and calls
`navigator.serviceWorker.register()`, the current document's CSP is already committed at parse time.
CSP cannot be modified on a live document.

This is the same TOFU (Trust On First Use) limit already accepted for the general bootstrap gap — it
is a web-platform property of the service-worker model, not a design bug in DappFence.

### Scope of the window

Service workers persist across sessions in the browser profile. Once installed, the SW controls all
later origin visits — even across browser restarts. Exposure is therefore:

-   **Very first visit ever** (SW not yet installed): the first document has origin's CSP.
-   **All later visits** (SW persisted from a prior visit): SW intercepts the first navigation at
    t=0; SW-emitted CSP applied. No gap.

So the "no SW-emitted CSP" case is a one-shot-per-user, not a one-shot-per-session.

### The initial document keeps the origin's CSP for its full lifetime

Because CSP is frozen at document creation, `clients.claim()` after SW activation makes the page
SW-controlled for **subresource fetches**, but does _not_ re-emit or replace the document's CSP. The
document created at t=1 lives its entire life under whatever CSP the origin committed, no matter how
much later the SW claims it.

This has a specific consequence for SPAs. A single-page app that uses `history.pushState` for in-app
"navigation" never creates a new document — the initial document _is_ the whole app for the lifetime
of the session. For a user's very first visit to an SPA:

-   The initial document's CSP is the origin's CSP.
-   Every client-side "route change" the user performs is still within that same document, still
    under that same CSP.
-   The SW's CSP-emission path is never exercised — because there is no second navigation.

For multipage apps the exposure is bounded by "how long the user stays on the first page before
clicking a link". For SPAs on the first visit, it is the entire session.

### What a CDN attacker can do in the window

-   Inject arbitrary `<script>` into the first HTML response.
-   Strip `<script src="/dappfence.js">` to prevent SW registration entirely, extending the window
    across the whole session for that visit.
-   Modify (or omit) the origin's `Content-Security-Policy` header to allow their injected script.

### What still holds back the attacker

-   **A strict origin CSP as a baseline.** If the developer configures a strict CSP on the actual
    origin server, an attacker at a CDN-level tampering position must also control the CSP header
    emission to weaken it. Not sufficient against a full CDN compromise, but it raises the bar
    against weaker positions (edge cache poisoning, downstream MITM). This baseline should be
    treated as a hardening layer, not a DappFence guarantee.
-   **Subresource verification still runs.** Once the SW claims the initial page, every subresource
    fetch (scripts, styles, images, HTML partials, JSON) goes through the SW and is byte-hashed
    against the manifest. What the initial document's CSP fails to constrain, subresource
    verification can still catch — for anything fetched after claim. Anything fetched _before_ claim
    (early hydration, top-of-body inline scripts) is neither CSP-gated by us nor SW-verified.
-   **Browser extension (planned).** The extension case installs the SW _before_ any origin response
    is committed, which closes this window entirely. Not shipped yet; when it lands, TOFU stops
    being a limit for installed users.

### Reload-after-claim — the only in-band closer

For non-SPA apps, the CSP gap is bounded: as soon as the user navigates (link click, form submit,
reload), the SW-emitted CSP kicks in. For SPAs, the gap is unbounded within the session.

The only mechanism that closes the SPA case is **forcing a reload once the SW has activated and
claimed the current page**. The reload's navigation goes through the SW → SW-emitted CSP is applied
to the new document → the SPA runs under it for the rest of the session.

Trade-offs:

-   **UX cost.** The user sees a visible reload on their very first visit. Acceptable for admin
    dashboards, financial apps, DappFence's primary target market. Rough for marketing pages or
    blog-style content where first-impression time matters.
-   **State loss.** In-progress form input on the initial page is lost. Mitigable by triggering the
    reload before the user has had time to interact — but the reload timing is nondeterministic
    (depends on SW install speed).
-   **Only fires on the very first visit.** All later visits get SW-emitted CSP from t=0 (SW
    persisted). So the UX cost is one-shot per user.

This mechanism is not implemented in the current codebase. Choosing to add it is a product decision
— it's the difference between "SPA first-visit users are outside the CSP guarantee for their entire
session" and "SPA first-visit users see a reload but are protected".

### What this means for the CSP strategy — scoping statement

Without reload-after-claim:

> DappFence's CSP guarantee applies from the moment the SW-controlled document is created.
> Multi-page apps get this at their second navigation. Single-page apps do not get it during the
> very first visit — they only get it on the next session. Subresource verification still runs from
> the moment of SW claim on all later fetches, even in the ungated document. Developers targeting
> protection for the initial page load must configure a strict `Content-Security-Policy` at the
> origin server.

With reload-after-claim:

> DappFence's CSP guarantee applies from the moment the SW-controlled document is created. On the
> very first visit, this involves a one-time visible reload after SW activation; for all later
> visits and navigations, SW-emitted CSP is in force from t=0.

## Open pushback / known limits

Documented for reviewers; some of these are honest weaknesses the design accepts.

-   **`script-src-attr 'unsafe-hashes'` weakens element binding.** Any injected element with a
    matching attribute value can trigger the handler. Only usable on staticPages (full-body-hashed)
    routes; on anything with mutable body it is a real hole. Prefer `addEventListener`.
-   **Case 15 (variant enumeration) forced buffering under the retired design.** The streaming
    rewriter's fixed-skeleton verification broke on conditional structures (auth state, feature
    flags, error banners), forcing full response buffering to identify the variant. This was one of
    the concrete reasons the streaming rewriter was dropped: the "streaming" story didn't hold for
    the common case. Under the current CSP-only direction, no body verification happens; the case
    isn't a "streaming vs buffering" question anymore.
-   **RSC Flight-protocol parser is a maintenance liability.** React does not document the wire
    format, and it churns between React versions. Owning this parser means tracking upstream. The
    cost per supported framework is high; scope this deliberately.
-   **Dynamic-leaf heuristics are load-bearing but weak.** "Looks like an integer / ISO timestamp /
    URL" won't survive an attacker who controls the leaf value. Content integrity of dynamic values
    is out of scope, but heuristics must still prevent _structural_ escape (e.g., a text-node
    heuristic must reject bytes that would break parser state, like `</script>` in the middle of a
    leaf).
