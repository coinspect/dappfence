# Verification model-fit: prevalence and gaps

This document quantifies, per case, what a **minimal DappFence deployment** covers vs. what it
leaves broken in real-world apps. It answers the question "if we only ship the simple parts of
`verification-cases.md`'s mechanism, how many apps can we protect and which patterns force us to
build the harder pieces?"

## The assumed minimal model

**Note — direction change (2026-06-25, updated 2026-08-19).** Earlier drafts of this doc split the
analysis between "the easy parts" (CSP hashes for build-time-stable inline) and "the hard direction"
(SW streaming rewriter with per-shape parsers and skeleton verification). The **general-shape**
parser has been retired: DappFence will not own a parser per framework inline shape (`window.<name>`
assignments, Astro island init, importmap validation, and so on). The mechanism assumed for the
first step below is CSP + a nonced bootstrap + a developer refactor of per-request state to inert
JSON data islands.

**One per-shape parser is planned as the next step: an RSC wire-format parser** for Next.js RSC push
chunks. It's narrow (one wire format), streaming-native, and targets the highest-value framework
payload; unlike the general-shape parser, its scope is bounded by React's evolution and doesn't grow
every time a framework invents a new inline shape. Cases 6, 7, 20 Pattern C, and 21 switch from
"incompatible" to "compatible" once it ships. Everything else in the retired scope stays retired.

The prevalence analysis retains its shape because the question — "how many apps break, which
patterns are the blockers?" — is still the right question; the answer just has two horizons:
first-step (only the RSC parser missing) and steady-state (RSC parser presents).

Precise so the analysis is honest:

-   **Assets** (`destination: "script" | "style" | "image" | "font"`, and static HTML): full SHA-256
    recorded in the manifest at build time. SW re-hashes on fetch and rejects on mismatch.
-   **Navigation** (`destination: "document"`): SW-injected CSP
    `script-src-elem 'nonce-<SW-N>' * ; script-src-attr 'none' ; ...`. The SW generates N per
    response and writes it onto its own bootstrap script. Every other inline `<script>` reaches the
    browser un-nonced and is blocked. External scripts pass CSP via `*` and are hash-verified by the
    SW at fetch time. Build-time-stable inline hashes may be listed as a defense-in-depth allowlist,
    but they are no longer the primary trust root.
-   **Sub-resource fetches** (`destination: ""`, called via JS from the page): governed by the
    parent page's CSP for the innerHTML-injected result. No separate CSP on the sub-resource
    response.

This model is what `verification-cases.md` § "The mechanism at a glance" describes. Under the
retired general-shape direction, an additional row would have said "the SW parses+verifies **every**
inline script shape at runtime and rewrites the nonce if verified"; that broad version is gone. The
planned RSC parser is a narrowed version — the same idea, one wire format. The question here is
therefore three-way: **which cases does the first-step model handle today, which become compatible
once the RSC parser ships, and which require the app to refactor?**

The prevalence figures below are estimates of how commonly each pattern appears in modern web apps
(2026 timeframe, weighted toward React / Astro / Next ecosystems and traditional server-rendered
apps). Sanity-checked against public 2025-2026 survey data (State of JS 2025, Stack Overflow
Developer Survey 2025, npm download trends, GitHub Octoverse 2025) — see "Assumption sensitivity" at
the bottom for what each number is anchored to.

### How to read the percentages

**Denominator:** each `%` is measured against **modern JavaScript-framework-based web apps built in
the 2026 ecosystem**. Explicitly:

-   ✅ Included: apps using React (any router), Vue, Svelte, Angular, Astro, Solid, Qwik, htmx,
    Hotwire.
-   ✅ Included: SSR / SSG / CSR / hybrid rendering strategies within those frameworks.
-   ❌ Excluded: pure static HTML sites (Wikipedia-style content, brochureware).
-   ❌ Excluded: pure server-side templated apps without any client-side framework (WordPress themes
    with no JS, plain Rails ERB, plain Django templates).
-   ❌ Excluded: CMS-driven sites that ship no framework runtime.

For the rationale behind this choice and the alternatives considered, see "Denominator: choice and
alternatives" at the bottom.

Under this denominator, each row reads "**of modern-framework apps, this fraction exercises this
pattern anywhere**." It is not a partition — the numbers do not sum to 100%, and by design **a
single real app hits many cases at once**. Every row is answered independently: pick a random
modern-framework app, does it use this pattern? Yes or no.

Concrete example: a typical Next.js App Router app exercises Cases 5, 6a, 6b, 7, 9, 11, 12, 16, 17,
18, and 20 simultaneously — ~11 cases in one deployment. That single app contributes a "yes" to
every one of those rows. Case 16 at ~100% reflects that essentially every modern-framework app ships
some JS asset; Case 12 at ~95% reflects that nearly everyone has a redirect somewhere. If the
numbers were a partition, both would be below 10%.

The bottom-line % ("model handles 55–65% of what apps do") is a rough weighted-coverage estimate:
across the response-traffic mix of a typical modern-framework app, what fraction is
fully-handled-without — parser vs. breaks-without-parser. This is a different kind of aggregate than
the per-row numbers and is not a sum of them.

## Case × prevalence × model-fit

| Case                                       | Rough % of apps                                                                                                                                                                    | What the model does                                                                                                                                                                                          | Works under model?                                                                       | Parser needed                                                                                                                                         | If parser missing                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Static prerendered partial               | 5% (htmx/Hotwire-ish, ~7% htmx usage per SO survey)                                                                                                                                | Asset hash                                                                                                                                                                                                   | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 2 Parameterized static partial             | 3% (enum'd content, subset of Case 1)                                                                                                                                              | Per-URL asset hash                                                                                                                                                                                           | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 3 SSR fixed skeleton                       | 15% (dashboards, admin panels)                                                                                                                                                     | Fetched → innerHTML'd → parent CSP shields execution                                                                                                                                                         | ✅ Works for execution                                                                   | HTML skeleton (only for content integrity, non-goal)                                                                                                  | Content tampering possible (already out of scope)                                                                                                                                                        |
| 4 Streaming SSR                            | 3% (rare — needs explicit streaming API)                                                                                                                                           | Same as Case 3                                                                                                                                                                                               | ✅ Works for execution                                                                   | HTML skeleton (non-goal)                                                                                                                              | Same as Case 3                                                                                                                                                                                           |
| 5 Pure JSON API                            | 90% (universal)                                                                                                                                                                    | Allowlist pass-through                                                                                                                                                                                       | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 6a RSC hard nav                            | 18% (App Router is default for new Next apps; Next is ~40% of React ecosystem, React ≥78% frontend)                                                                                | Inline RSC push scripts vary per request; need SW parse + nonce                                                                                                                                              | ❌ **Breaks** without parser                                                             | RSC wire-format parser                                                                                                                                | **Hydration fails → no interactivity → page appears broken.** React unmounts after mismatch.                                                                                                             |
| 6b RSC client nav                          | 18%                                                                                                                                                                                | Same as 6a on `text/x-component` transport                                                                                                                                                                   | ❌ Breaks without parser                                                                 | RSC parser                                                                                                                                            | Client-nav fetch errors → falls back to hard nav (Case 6a) which is also broken                                                                                                                          |
| 7 RSC Suspense                             | 10% (App Router apps that use Suspense boundaries)                                                                                                                                 | Streaming RSC                                                                                                                                                                                                | ❌ Breaks without parser                                                                 | Streaming RSC parser                                                                                                                                  | Same as 6a; Suspense boundaries never resolve                                                                                                                                                            |
| 8 JSON data island in partial              | 5% (JSON island _in a fetched HTML partial_ is a rare combo)                                                                                                                       | Fetched → innerHTML'd; island CSP-exempt by MIME; any tampering the client re-reads via `getElementById().textContent` reduces to "different data reaches client" = content integrity (non-goal)             | ✅ Works                                                                                 | **none** (under strict-scope reading — see note below)                                                                                                | Structural attacks (duplicated island, id rename, MIME swap) succeed silently but only substitute content, which is a non-goal. Execution safety is intact via CSP + parser rule.                        |
| 9 Full SSR page                            | 55% (SSR is now the norm; edge SSR projected >50% by 2026)                                                                                                                         | If page has only stable inline scripts → hash-in-CSP works. If any dynamic inline → needs parser                                                                                                             | ⚠️ Depends on inline-script shape                                                        | HTML skeleton parser (if page has dynamic inline)                                                                                                     | Dynamic inline scripts blocked → framework init may fail (dark-mode flash, missing hydration for older frameworks). Static SSR without inline scripts: works.                                            |
| 10 Astro server islands                    | 1% (Astro ~2-3% of ecosystem post-Cloudflare acquisition; islands used in ~30% of Astro apps)                                                                                      | Astro auto-emits per-request init script (`fetch('/_server-islands/…')`) → body varies with prop hash → needs SW verify + nonce                                                                              | ❌ **Breaks** without parser                                                             | Astro-init shape parser                                                                                                                               | **Init script blocked → islands never load → skeletons visible forever.**                                                                                                                                |
| 11 Server Actions                          | 12% (Next App Router adoption + mutation-heavy apps)                                                                                                                               | Request-side: SW needs `Next-Action` allowlist. Response is `text/x-component`, React consumes as data (no parser needed for execution safety)                                                               | ✅ Works with allowlist config                                                           | none (response); allowlist schema for requests                                                                                                        | Attacker-injected forged POST vector remains open                                                                                                                                                        |
| 12 Redirects                               | 95% (universal)                                                                                                                                                                    | Verify final response                                                                                                                                                                                        | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 13 CSP nonce partial                       | 3% (specific shape)                                                                                                                                                                | SW's own CSP + strip contract for origin CSP                                                                                                                                                                 | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 14 Inline JS with server data (as partial) | 5% (this shape _in a partial_ is rare; the syntactically-identical shape _in an SSR page_ is Case 20 Pattern A)                                                                    | Fetched → innerHTML'd → `<script>` inert by parser rule                                                                                                                                                      | ✅ Works                                                                                 | none (as partial)                                                                                                                                     | —                                                                                                                                                                                                        |
| 15 Conditional SSR partial                 | 40% (universal in _SSR_ apps; drops sharply for pure-SPA/JSON-API stacks)                                                                                                          | Fetched → innerHTML'd → parent CSP shields execution                                                                                                                                                         | ✅ Works for execution                                                                   | HTML skeleton with variant support (non-goal)                                                                                                         | Content tampering possible (non-goal); execution safe                                                                                                                                                    |
| 16 Static JS asset                         | 100% (universal)                                                                                                                                                                   | Asset hash                                                                                                                                                                                                   | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 17 Non-enum'd JSON API                     | 75% (very common)                                                                                                                                                                  | Allowlist pass-through                                                                                                                                                                                       | ✅ Works                                                                                 | none                                                                                                                                                  | —                                                                                                                                                                                                        |
| 18 Variable-length list                    | 60% (universal in SSR apps with data lists; less common in pure SPAs)                                                                                                              | Allowlist; parent CSP shields execution                                                                                                                                                                      | ✅ Works for execution                                                                   | none                                                                                                                                                  | Composition inversion — CSP is sole defense. Broken if consumer refactors from innerHTML to `document.write` or similar.                                                                                 |
| 19 SSR nav no `getStaticPaths`             | 40% (user content, profile pages, product pages with runtime IDs)                                                                                                                  | No manifest entry for this URL → CSP has no inline hashes → all inline scripts blocked. Streaming rewriter fixes via route-pattern manifest.                                                                 | ⚠️ **Framework bootstrapper broken**; page-specific inline never manifestable regardless | Route-pattern manifest match                                                                                                                          | **Framework theme bootstrapper blocked → dark-mode flash on every visit. Page-specific inline scripts stay blocked always (forcing function).**                                                          |
| 20 Per-request inline data on SSR page     | 60% (Pattern A `__INITIAL_STATE__`/`__NEXT_DATA__` in Pages Router + Redux-style SSR hydration; Pattern C RSC push in App Router. Pattern A is declining as Pattern C replaces it) | Pattern A (`window.VAR = <literal>`) body changes per ms → no stable hash → SW parser + nonce required. Pattern B (JSON island) CSP-exempt, works with **no parser**. Pattern C (RSC push) needs RSC parser. | ⚠️ Pattern A/C **break**; Pattern B works                                                | `window.VAR` JS-assignment parser (for Pattern A) + RSC parser (for Pattern C). **Pattern B needs none** — same as Case 8 under strict-scope reading. | **`__NEXT_DATA__` / `__INITIAL_STATE__` / RSC hydration all blocked → client app can't read server state → SPA broken.** Pattern B (JSON island) always works as an escape hatch, with zero parser lift. |
| 21 ISR page (revalidate)                   | 6% (Next-specific ISR use; less common than Case 20 since it requires explicit `revalidate` config)                                                                                | RSC push bytes change on regen → build-time hash goes stale within `revalidate` window                                                                                                                       | ⚠️ **Works pre-revalidation, breaks post**                                               | RSC parser + skeleton range coverage                                                                                                                  | **First minute after build: works. After first revalidation: RSC push hashes stale → CSP blocks → hydration fails.** Ticking-time-bomb failure mode.                                                     |

## Which patterns actually need the SW streaming parser

Bucketing the "Parser needed" column by parser type:

**Zero parser work** — Cases 1, 2, 5, 8, 11 (request-side only), 12, 13, 14, 16, 17, and **Case 20
Pattern B**. These need only manifest schema entries and correct SW routing. JSON islands (Case 8,
Case 20B) belong here under the strict-scope reading — see the scope note below.

**Parent-CSP-only** (works because fetch+innerHTML result is CSP-governed by the parent page) —
Cases 3, 4, 15, 18. Execution safety works; content integrity is a documented non-goal. Roughly
universal in dashboards / real SSR apps.

**JS-assignment parser** (`window.VAR = <literal>`) — Case 14 (harmless without, script inert), Case
20 Pattern A (**required** for state hydration).

**RSC parser (targeted, streaming)** — Cases 6a, 6b, 7, 20 Pattern C, 21. **First step: not yet
shipped. Next step: planned.** The RSC parser is the one per-shape verifier that survived the
2026-06-25 scope cut — a narrow parser for the RSC Flight wire format, not the general-shape parser
that was retired. Under first-step CSP-only, Next.js App Router hydration breaks unless the app
moves the per-request state into a JSON data island (Case 20 Pattern B) — but this is the temporary
state, not the end state. Once the RSC parser ships, these cases become compatible for Next.js RSC
apps out of the box.

**HTML skeleton parser with variant support** — Cases 3, 4, 9 (dynamic inline), 15, 18. **Retired.**
For execution safety in Cases 3/4/15/18, innerHTML inertness + host-document CSP carries; no parser
required. For Case 9 with dynamic inline scripts, the current direction requires refactoring the
inline scripts to data islands (state) or externalizing them (behavior).

**Route-pattern manifest** — Case 19. Enables framework bootstrappers on non-enumerable routes.
Without it, dark-modes flash on every visit to user-content routes.

**Astro-init shape parser** — Case 10. **Retired.** Astro server-island init scripts must be
refactored (or an equivalent bootstrapping mechanism must land in Astro upstream) — DappFence no
longer provides a per-shape parser for them.

**JS-assignment parser** (`window.VAR = <literal>`) — Case 20 Pattern A. **Retired.** Per-request
state assignments break; apps must switch to Pattern B (data island).

### Scope note: JSON islands and the parser

Cases 8 and 20 Pattern B use `<script type="application/json" id="…">…</script>`. Under the doc's
declared scope ("no attacker-controlled JavaScript executes"), these need **no parser at all**.
Reasoning:

-   The island is **inert-by-MIME** — the browser never executes it. CSP `script-src` isn't
    consulted because there's nothing to execute.
-   If an attacker rewrites the `type` attribute to make the tag executable, one of two shields
    catches it: **innerHTML parser rule** (fetched-partial context, Case 8) or **strict CSP with no
    matching hash/nonce** (SSR-page context, Case 20B).
-   If an attacker duplicates the island, renames the id, deletes it, or MIME-swaps a lookalike, the
    client's `getElementById` returns attacker-substituted values or `null`. This changes what data
    reaches the client — but under strict-scope reading, that's a **content change**, not an
    execution attack. Content integrity is a documented non-goal.
-   The only paths where JSON-island tampering leads to attacker code executing require the client
    to use the values _as code_ (`eval`, `<script src>` from a URL in the JSON, `innerHTML` with
    HTML in the JSON). Every such path is caught by mechanisms DappFence has for other reasons:
    `script-src` without `'unsafe-eval'`, Case 16 unmanifested-asset-load block,
    `script-src-attr 'none'`.

**Consequence for implementation planning**: JSON-island vectors on the tampering surface (Case 8,
Case 20 Pattern B) are structural-integrity nice-to-haves under the strict-scope reading — not
required for the declared execution-safety guarantee. If DappFence wants to close DOM-shape /
island-substitution attacks, that would be an explicit scope-expansion decision.

## What actually breaks in the wild without the SW streaming parser

Weighted by prevalence, the _practical_ damage:

| Failure mode                                                                                        | Affected % of apps                                                                                          | Severity                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| React RSC hydration (Cases 6a/6b/7)                                                                 | ~18% (App Router is default for new Next apps; adoption trajectory is steep)                                | **Critical** — page renders but no interactivity                  |
| SSR state hydration (Case 20 Pattern A/C, `__NEXT_DATA__` / `__INITIAL_STATE__` / Redux / RSC push) | ~60% (most React/Vue SSR apps; Pattern A dominant in Pages Router legacy, Pattern C dominant in App Router) | **Critical** — client app can't read server state                 |
| ISR regeneration (Case 21)                                                                          | ~6% of Next apps                                                                                            | **Delayed-critical** — works at first, breaks on first revalidate |
| Framework theme bootstrapper on dynamic-nav routes (Case 19)                                        | ~40%                                                                                                        | **Cosmetic** — dark-mode flash, occasional missing init           |
| Astro server islands (Case 10)                                                                      | ~1%                                                                                                         | **Critical** for the affected 1%                                  |

**Bottom line**: the "just hash and set CSP" model handles roughly 55–65% of what apps do (static
content, JSON APIs, redirects, simple SSR without state hydration, fetch+innerHTML partials shielded
by parent CSP). It **fails on the specific pattern that makes modern React/Next apps interactive** —
the executable inline data / RSC push script hydration pattern. So the streaming parser and nonce
mechanism isn't optional dressing; it's the difference between DappFence being deployable to a
static-site + JSON-API stack and DappFence being deployable to a Next.js App Router SPA — the
direction the ecosystem is trending.

**Trajectory matters more than the current snapshot.** Two 2026 trends compound each other on the
"you need the parser" side:

1. **App Router adoption is the default for new Next apps** (Next 15/16 ships all new features
   App-Router-only; Pages Router in maintenance mode). RSC-pattern responses become more common
   every quarter.
2. **RSC replaces traditional hydration** (`__NEXT_DATA__` blob → `self.__next_f.push(...)`
   streams). Same "executable inline data" problem, different wire format. Both need the SW parser;
   the shift just moves prevalence from Pattern A to Pattern C.

Island architecture is projected to power 30–40% of new projects by 2026 — mostly Astro but also
Qwik and others — which validates Case 10's mechanism being needed if DappFence targets the
fastest-growing content — site frameworks.

## Assumption sensitivity

Estimates in the table above are anchored to the following 2025–2026 data points. Where a number has
been revised from an earlier draft, the change reason is called out.

1. **React dominance** — Stack Overflow Developer Survey 2025 reports React at ~44–45% overall
   developer usage and ≥78% among frontend developers. State of JS 2025 shows React satisfaction
   dropped to its lowest point while raw usage stayed at 83.6% — dominant but no longer beloved.
2. **Next.js App Router adoption (Cases 6a/6b/7).** Revised **up from 10% → ~18%**. Next 15/16 ship
   all new features App-Router-only; Pages Router is in maintenance mode. All new Next projects in
   2026 default to App Router. Next.js is roughly 40% of the React ecosystem (based on npm and
   framework surveys); React is ≥78% of frontend. App Router prevalence in the _whole_ ecosystem is
   around 15-20% and rising quarterly.
3. **State-hydration prevalence (Case 20).** Revised **up from 55% → ~60%** to reflect Pattern A +
   Pattern C combined. Pattern A (`__INITIAL_STATE__` / `__NEXT_DATA__` / Redux dehydration) is
   dominant in Pages Router legacy apps; Pattern C (RSC push scripts) is dominant in App Router.
   Both need the SW parser; the ecosystem shift moves prevalence between them but doesn't reduce the
   total. Any SPA with SSR does one or the other.
4. **Conditional-SSR-partial (Case 15).** Revised **down from 80% → ~40%** — the earlier 80% assumed
   the app has an SSR frontend at all. Pure JSON-API + SPA stacks have no SSR partials. Weighted
   across all app archetypes (including pure SPAs), ~40% is a better central estimate.
5. **Variable-length list (Case 18).** Revised **down from 85% → ~60%** for the same reason as Case
   15 — universal _within SSR apps_, absent in pure-SPA stacks.
6. **Astro server islands (Case 10).** Kept at ~1%. Astro reached 1.9M npm weekly downloads in 2026
   (up from 1.1M in 2024), acquired by Cloudflare in January 2026, and ranked #1 in State of JS 2025
   meta-framework satisfaction. Astro overall is ~2-3% of the ecosystem; server islands are used in
   ~30% of Astro projects; net ~0.6-1% of all apps.
7. **htmx / Hotwire (Cases 1, 2, 3, 4).** Revised **down from 8/5/20/3% → 5/3/15/3%**. htmx has 47K
   GitHub stars and #1 satisfaction on State of JS 2025, but production adoption sits at ~7% of
   developers (Stack Overflow 2025) vs React's 44%. Growing outside the Silicon Valley bubble, still
   a clear minority.
8. **Islands architecture** projected to power **30-40% of new projects by 2026** — Astro leads that
   category, but Qwik and others count too. If islands trend continues, Case 10's mechanism becomes
   materially more important beyond Astro-specific numbers.
9. **Server Actions (Case 11).** Revised **up from 8% → ~12%** — scales with App Router adoption.
10. **RSC replaces `__NEXT_DATA__`.** Traditional hydration is being replaced by RSC in App Router
    apps. The doc's Case 20 Pattern A (`window.__NEXT_DATA__` etc.) is a declining shape _inside_
    the Next ecosystem, replaced by Pattern C (RSC push). Both still need the SW parser; the
    ecosystem shift moves prevalence between them but doesn't reduce the total. The number that
    drops is the Pages-Router-specific `__NEXT_DATA__` share; the number that grows is the
    App-Router-specific `self.__next_f.push(...)` share.

The two numbers most likely to shift the bottom line are the App Router share (Cases 6/7/11/21) and
the state-hydration share (Case 20). Both have trended _upward_ since the initial draft was written,
which strengthens the case for the SW streaming parser rather than weakening it.

## Denominator: choice and alternatives

### Choice: modern JavaScript-framework-based web apps

This is the denominator used throughout the table above.

**Rationale** — this is the population DappFence would realistically be deployed to protect. Static
WordPress sites don't need a browser — integrity SW; they're not the audience. Under this
denominator, the numbers become internally consistent and comparable.

### Alternatives considered

-   **HTTP Archive top-1M-weighted**: rigorous, third-party data available, but skewed heavily
    toward static content sites — the "% that needs parser" drops to ~15-20% because most top-1M
    sites are content sites.
-   **Traffic-weighted rather than app-weighted**: bigger apps have more traffic; if 1% of apps get
    99% of traffic and those 1% are Netflix/Uber/etc. (React SSR heavy), the "% traffic that needs
    parser" is much higher.
-   **DappFence's specific target audience (dapps + crypto/finance)**: probably 70-80%+ need the
    parser, but this population is hard to size.

---

## Cross-refs

-   Mechanism specification: `verification-cases.md`.
-   Runnable examples for each case: `@dappfence/example-nextjs` / `@dappfence/example-astro` in the
    `dappfence-examples` repo.
