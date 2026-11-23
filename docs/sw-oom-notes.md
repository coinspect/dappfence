# Service Worker OOM notes

Empirical notes on how DappFence's SW and Chromium itself behave under oversized response bodies on
the hash-every-response path. The write-up exists because an earlier design conversation argued for
a response-size cap in the SW, got pushback on principle, and then we weren't sure whose intuition
matched reality. These are the receipts.

The accompanying test harness is in `packages/test-app/test/sw-oom/`. Run it locally with
`RUN_OOM=1 npx playwright test --project=sw-oom-dev` from `packages/test-app`. Expect 40+ minutes of
wall time at the large sizes.

## The question

DappFence hashes every response body it verifies. That hash step is one of two things, depending on
who's doing it:

1. **In the SW:** `await response.clone().arrayBuffer()` followed by
   `crypto.subtle.digest('SHA-256', bytes)`. The ArrayBuffer sits in the SW's V8 heap.
2. **In the browser (as a comparison target):** CSP hash sources (`script-src 'sha256-…'`) make
   Chromium itself compute a SHA-256 over an inline `<script>` body before allowing execution.

Both paths buffer the full body before hashing. Neither has a native streaming-digest API. The
practical question: **what happens at the limits** — does the SW crash? Does the browser crash? Does
anything crash? Is there a usable upper bound, or is the hash step unbounded?

The earlier memo in this thread predicted "multi-GB bodies crash the SW process with multi-tab blast
radius." The actual measurements below revise that materially.

## Methodology

The hard part is testing multi-GB responses without the server, test harness, or disk needing
multi-GB of memory or storage. Solved by generating the body from a seeded PRNG (xorshift32):

-   Server endpoint `/huge/bytes?mb=N&seed=S` streams `N` MB of hex PRNG output wrapped as
    `const _ = "…hex…";void _;` so it parses as valid JS. Hex is safe inside any string / HTML /
    comment — never contains `"`, `\`, `</script>`, or `*/`.
-   Everything is deterministic by `(seed, N)`, so the server and the test agree on the SHA-256
    without either party holding the body. Hashes are memoized in-process for the dev-server's
    lifetime (first computation at 3 GB costs ~25s; subsequent requests reuse).
-   Five related endpoints (`/huge/bytes`, `/huge/sri-page`, `/huge/csp-page`, `/huge/df-page`) wire
    the payload into the three hashing paths we care about.

The tests use `reporting-test-dev` as the active app so the SW stays in `mode: 'reporting'`. In
reporting mode, repeated NOT_IN_MANIFEST violations don't trigger the site-lock short-circuit —
every iteration pays the full hash cost rather than being served a cached block response. (This also
means the SW passes the huge body through to the page after hashing, which matters for interpreting
the page-crash signal below.)

## Test cases and results

### (c) Linear-growth — 100 / 250 / 500 MB

Baseline proof that DappFence buffers everything and hashes it.

| Size   | Elapsed (ms) | ms per MB |
| ------ | ------------ | --------- |
| 100 MB | 4,626        | 46        |
| 250 MB | 18,225       | 73        |
| 500 MB | 58,278       | 117       |

Script tag `onload` fires cleanly every time — SW hashed, verified (reported NOT_IN_MANIFEST),
passed body through, browser parsed it.

Per-MB cost **more than doubles** between 100 and 500 MB. That's allocation + GC overhead growing as
the `Uint8Array` the SW materializes pushes against V8's old-space. The hash step itself is linear;
the buffer-into-V8 step is not.

### (b) 2.1 GB body — hits the hash wall

| Signal        | Value                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| SW crashed    | **no**                                                                    |
| Page crashed  | **yes**                                                                   |
| SW console    | `SECURITY ALERT: Verification error (BODY_UNREADABLE)! File: /huge/bytes` |
| Script loaded | n/a (page died first)                                                     |

The important finding: **the SW doesn't crash.** DappFence already wraps
`response.clone().arrayBuffer()` in a `try/catch` (see `sw/manifest/html/response-wrapper.js:28`).
When V8 can't allocate the ArrayBuffer (RangeError or allocation failure), the catch returns
`{ status: ERROR, reason: 'BODY_UNREADABLE' }` and the SW survives.

The **page** process then crashes, because reporting mode passed the body through to the browser,
which tries to allocate 2.1 GB of JS source in the page renderer and runs out of V8 heap. This is a
**single-tab DoS** — not multi-tab, and the SW keeps serving other requests.

### (a) 3 GB body

Same story as (b). SW survives (BODY_UNREADABLE). Page crashes.

### (d) Blast-radius probe — 3 GB on one tab, second tab watching

| Signal                   | Value                        |
| ------------------------ | ---------------------------- |
| SW crashed               | **no**                       |
| Tab A's page crashed     | yes                          |
| Tab B's controller after | **true** (still controlling) |

**Refutes the multi-tab blast-radius claim** as applied to DappFence today. The SW doesn't die, so
tab B's controller survives. The attack degrades to "tab A's page crashes." Whether that's
acceptable is a different question — it's still a working DoS primitive against a single tab per
page view — but it isn't the site-wide outage the earlier memo described.

### (CSP-sweep) Browser CSP-hash path — no DappFence

Walks `script-src 'sha256-…'` from 500 MB to 2.5 GB inline. Uses a separate nonce for marker scripts
so the `'unsafe-inline' ignored when hash present` CSP quirk doesn't masquerade as a hash-mismatch
signal.

| Size    | Nav     | Inline script ran | CSP violation fired | Elapsed |
| ------- | ------- | ----------------- | ------------------- | ------- |
| 500 MB  | OK      | **yes**           | none                | 108.3s  |
| 1000 MB | OK      | **yes**           | none                | 212.2s  |
| 1500 MB | OK      | **yes**           | none                | 456.9s  |
| 2000 MB | timeout | no                | none                | 10 min+ |
| 2500 MB | timeout | no                | none                | 10 min+ |

**Chromium computes a SHA-256 over a 1.5 GB inline `<script>` body cleanly** — 7.6 minutes, no
crash, no error, no CSP violation, script runs on the matched hash. That's a real finding: the
earlier source audit suggested Chromium holds the body in `SegmentedBuffer` with no cap, and we
expected either a renderer OOM or a hard size rejection around 2 GB. Neither happened in this run on
a 64-bit desktop renderer.

At 2 GB+ we hit the test's 10-minute `page.goto` timeout with zero other signals. The browser didn't
crash, didn't emit a violation, didn't return an error — it just hadn't finished within the budget.
Whether 2 GB would eventually finish at 20 minutes, or whether Chromium silently gave up without
emitting any event, is open. See the open-questions section.

## Revised threat model

Replaces the version in the earlier conversation memo. Changes marked with → where my earlier
framing was wrong.

-   **"Any origin your SW hashes can crash the SW."** → **False as implemented.** DappFence catches
    ArrayBuffer allocation failure and returns `ERROR / BODY_UNREADABLE`. The SW survives.
-   **"Multi-tab blast radius: SW death loses the controller in every tab."** → **Not triggered
    today.** The SW doesn't die on oversize bodies. The claim remains correct _in principle_ (if a
    future bug or change broke the catch), but current code doesn't exercise it. The (d) test
    reflects this: it asserts the conditional "if the SW crashed, tab B lost controller," not "the
    SW crashed."
-   **Reporting mode:** attacker-served multi-GB response → SW hash fails with BODY_UNREADABLE → SW
    passes body through → **page V8 OOM → single-tab crash DoS.** Same URL on another tab reproduces
    the crash on that tab; the SW itself keeps working, other requests keep flowing.
-   **Protected mode:** same hash failure, but DappFence treats `ERROR / BODY_UNREADABLE` as a
    violation and returns a block response. The script fires `onerror`; the page keeps running. The
    user-visible failure mode shifts to "legitimate huge resources (video chunks, large bundles) are
    indistinguishable from an attacker payload." A content-length pre-check would let an operator
    distinguish _oversize, unverified_ from _tampered_.
-   **Browser CSP-hash path:** no observed hard upper bound up to 1.5 GB. Chromium hashes and
    executes. At 2+ GB, undetermined — pending the longer-timeout probe.

## Open questions (probes queued)

1. **CSP: slow vs. hung at 2 GB?** Rerun 2 GB with a 20-minute `page.goto` timeout. If it completes,
   Chromium has no hard CSP-hash cap (just super-linear slowness, same pattern as the smaller
   sizes). If it times out again, points to a silent giveup.
2. **SW: bracket where BODY_UNREADABLE starts.** Today we know the SW survives 500 MB (hashes
   cleanly) and fails at 2.1 GB (BODY_UNREADABLE). The boundary is probably around V8's
   `ArrayBuffer` max — nominally 2 GiB but the practical ceiling varies with V8 heap limits. A short
   sweep at 1000 / 1500 / 1750 / 2000 MB would pin where the catch starts firing.

Both are tracked as follow-up runs; neither blocks the write-up.

## How to run the harness

Prerequisites:

-   Node 16+, Playwright browsers installed (`npx playwright install`).
-   At least 8 GB free RAM to run the multi-GB tests without host swapping.
-   Patience: full sweep is ~40 minutes of wall time.

From `packages/test-app/`:

```sh
# Full suite — gated behind RUN_OOM=1; all tests skipped without it.
RUN_OOM=1 npx playwright test --project=sw-oom-dev

# Quick regression (~1.5 min): proves buffering happens, no multi-GB
# needed.
RUN_OOM=1 npx playwright test --project=sw-oom-dev -g '(c)'

# CSP sweep (~30 min): browser-side bracket.
RUN_OOM=1 npx playwright test --project=sw-oom-dev -g 'CSP-sweep'
```

The server endpoints are usable standalone;
`curl -o /dev/null 'http://localhost:3333/huge/bytes?mb=500&seed=1'` streams 500 MB of deterministic
bytes without the server allocating anything beyond a 64 KB write buffer.

## References

-   Chromium SRI/CSP hash path:
    `third_party/blink/renderer/platform/loader/subresource_integrity.cc`,
    `third_party/blink/renderer/platform/crypto.cc` (BoringSSL `EVP_DigestUpdate` iterating
    `SegmentedBuffer` segments).
-   DappFence catch: `packages/dappfence/src/sw/manifest/html/response-wrapper.js`, `getBodyBytes()`
    try/catch.
-   V8 `ArrayBuffer` sizing: nominally `kMaxByteLength` = 2 GiB on 32-bit, up to the heap limit on
    64-bit; allocation failure throws `RangeError` in the JS layer rather than crashing the process.
-   Firefox streaming SRI (comparison point): `dom/security/SRICheck.cpp`, Mozilla bug 1187335 —
    maintains O(1) memory on the digest path, so the equivalent DappFence refactor is "stream
    through an incremental WASM SHA-256."
