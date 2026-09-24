# Blocking `importScripts` Verification via SharedWorker + Atomics

## Problem

When DappFence's SW loads the app service worker via `importScripts(config.appSW)`, and when the app
SW itself calls `importScripts()` for additional scripts, verification is currently
**fire-and-forget**: the script is fetched and executed synchronously by the browser before the
async hash check completes. A compromised script runs before DappFence can do anything about it.

The fetch handler covers `<script>` tags on controlled pages — those go through `respondWith()`
which can hold the response until verification passes. `importScripts` inside the SW is the
remaining gap.

## Why blocking is hard

`importScripts` is synchronous. Inside the monkey-patch handler, there is no way to await an async
operation. The constraints in SW scope are:

-   No `XMLHttpRequest` (sync mode available in dedicated Workers but excluded from
    `ServiceWorkerGlobalScope`)
-   No sub-Workers (`new Worker()` is not exposed in `ServiceWorkerGlobalScope`)
-   `importScripts` itself rejects blob and data URLs in SW context — the browser's update algorithm
    needs to re-fetch imported scripts to check for changes, so ephemeral URLs are rejected
-   `Atomics.wait` is available (SW has `AgentCanBlock = true`) but requires another thread to call
    `Atomics.notify` to unblock it — no such thread can be created from within the SW

The only synchronous blocking primitive in SW scope is `Atomics.wait`. Any solution that truly
blocks `importScripts` must flow through it.

## Proposed design

### Overview

A **SharedWorker** spawned from the page that calls `register()` acts as the persistent verification
thread. It holds a `SharedArrayBuffer`, performs async fetch and hash, and calls `Atomics.notify` to
unblock the SW.

### Sequence

```
Page calls register()
  → DappFence client code creates SharedWorker
  → SharedWorker creates SharedArrayBuffer (SAB), waits for requests

SW install event fires
  → fetchAndStoreManifest()  [async, takes time — natural window for handshake]
  → clients.matchAll({ includeUncontrolled: true }) → gets the registering page
  → page forwards MessageChannel port to SharedWorker
  → SW and SharedWorker now share SAB + direct port

importScripts(url) called (monkey-patched)
  → SW sends url + expected hash to SharedWorker via port
  → SW calls Atomics.wait(int32, 0, PENDING)   [blocks]
  → SharedWorker fetches url, computes SHA-256 via crypto.subtle
  → SharedWorker writes PASS or FAIL into SAB
  → SharedWorker calls Atomics.notify(int32, 0)
  → SW unblocks, reads result
  → if PASS: call original importScripts
  → if FAIL: throw / record violation / block install
```

### Why SharedWorker and not dedicated Worker

A dedicated Worker is owned by its document and is terminated on page reload or navigation. A
SharedWorker lives as long as at least one document from the same origin holds a connection. In
practice, browsers preserve the SharedWorker across single-tab reloads during the brief reconnection
window (implementation behavior, not spec-guaranteed, but reliable in Chrome and Firefox).

This means the SAB and port established during the first installation remain valid across normal
page reloads without re-handshaking, which is important for SW update events.

### Direct SW ↔ SharedWorker communication

A SharedWorker created by a controlled page is itself a **client** of the SW — it appears in
`clients.matchAll()`. Once a `MessageChannel` port is exchanged (SW sends port to SharedWorker via
the clients API, or the page acts as broker), communication is direct and bidirectional without the
page as intermediary.

The SharedWorker cannot call `navigator.serviceWorker.register()` — `WorkerNavigator` does not
expose `ServiceWorkerContainer`. The page must still own the registration.

## Known gaps

### `SharedArrayBuffer` requires cross-origin isolation

`new SharedArrayBuffer()` throws unless the page is cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This is a deployment requirement the site owner must opt into. Without it the entire mechanism is
unavailable, and the fallback is current fire-and-forget behavior.

### Background SW update (24-hour check)

The browser performs a periodic SW update check even with **zero pages open**. If a new SW version
is found, the `install` event fires and `importScripts` is called with no page present, meaning no
SharedWorker, no SAB. This case falls back to fire-and-forget.

Navigation-triggered updates (the common case) always have a page open and are covered.

### First page load bootstrap gap

On the very first page load, no SW exists yet. All `<script>` tags on that page are fetched and
executed before the SW is installed and active. This is the accepted bootstrap trust constraint — it
applies equally here and is not specific to `importScripts` blocking.

## Alternative: throw-then-retry

Instead of blocking synchronously, use the SW install retry mechanism as the wait primitive.

### Sequence

```
importScripts(url) called (monkey-patched) — first attempt
  → do NOT call original importScripts
  → start async fetch(url) + SHA-256 hash
  → throw — install event fails, script never runs

Browser retries install
  → DappFence install handler pre-loads verified content from IndexedDB into memory Map
  → importScripts(url) called again
  → monkey-patch checks memory Map
  → if PASS: (0, eval)(verifiedContent) — no throw
  → if FAIL: throw / record violation / block install permanently
```

### Advantages over SharedWorker + Atomics

-   No COOP+COEP headers required
-   Works for background SW updates (no page present)
-   No SharedWorker, no `Atomics.wait`, no MessageChannel handshake
-   Simpler to implement and reason about

### TOCTOU

No TOCTOU gap: the retry uses the cached bytes — the same content that was verified is the content
that gets eval'd. This is the same property as the pure async eval approach below.

The SharedWorker approach does have a TOCTOU gap: the SharedWorker fetches for hashing, then the
original `importScripts` makes a second browser-level fetch.

### When to prefer throw-then-retry over pure async eval

Throw-then-retry maintains the synchronous contract: on the retry attempt, `importScripts` returns
only after `eval` completes, so imported symbols are available on the next line. Use it when the app
SW uses imported symbols in top-level synchronous code immediately after `importScripts`. For
standard event-handler-based SW code, the simpler async eval approach (below) is enough.

### Constraints

-   The first `install` always fails and requires a browser retry — adds latency to initial SW
    installation.
-   In-memory content cache must be preloaded from IndexedDB at the start of each `install` event,
    before the app SW runs and its `importScripts` calls fire.

## Alternative: fetch + eval

Instead of calling `importScripts(url)`, fetch the content manually, verify the hash, then execute
via `eval`. The content that is hashed is the content that runs — the TOCTOU gap is fully
eliminated.

### How it works

```
importScripts(url) called (monkey-patched)
  → do NOT call original importScripts
  → fetch(url) → read response body as text
  → compute SHA-256, compare against manifest
  → if PASS: (0, eval)(scriptContent)
  → if FAIL: throw / record violation
```

Indirect eval (`(0, eval)(code)`) executes in the global scope, matching `importScripts` semantics:
global variable and function declarations become properties of `self`.

### Advantages

-   **No TOCTOU**: the bytes verified are the bytes executed.
-   No SharedWorker, no Atomics, no COOP+COEP.
-   Works for background updates (no page needed).
-   No throw-then-retry needed — see below.

### Why throw-then-retry is not needed

`addEventListener` is already monkey-patched globally by DappFence. App SW code registers its event
listeners through the patch, which queues them in a Map rather than forwarding them to the real
`addEventListener` immediately. Event handlers only fire after DappFence's own `install` handler
completes — and `event.waitUntil` keeps the `install` event alive until all async work finishes.

This means the monkey-patched `importScripts` can return synchronously without having eval'd the
content yet:

```
importScripts(url) called (monkey-patched) — any call, including nested
  → do NOT call original importScripts
  → start async: fetch(url) → SHA-256 → (0, eval)(content) if PASS, record violation if FAIL
  → return synchronously (importScripts returns void)
  → pending Promise tracked in install waitUntil set

install event waitUntil resolves when all pending verifications complete
  → any failure rejects the install
  → on success, all scripts are eval'd before any event handler fires
```

Nested `importScripts` calls within eval'd app SW code hit the same global monkey-patch and follow
the same async path. No retry, no cache warm-up step.

**One real constraint**: top-level synchronous use of an imported symbol on the next line fails
because the eval hasn't happened yet when that line runs:

```js
importScripts('lib.js');
const x = libFunction(); // TypeError — libFunction not yet defined
```

This is not the standard SW pattern. Normal SW code registers event handlers and defers all logic
into them — those handlers fire after install completes, at which point all evals are done.

### Constraints

**CSP — `'unsafe-eval'` required**: If the SW script response includes a `Content-Security-Policy`
header with `script-src` that omits `'unsafe-eval'`, the browser will reject the `eval` call.
Security-conscious sites — exactly the sites DappFence targets — are likely to have this
restriction. This is the primary practical blocker for the approach.

**SW update algorithm**: The browser tracks URLs loaded via `importScripts` for its periodic
change-detection sweep (the 24-hour check). Scripts executed via `eval` are invisible to this
mechanism. DappFence would take over full responsibility for detecting SW script changes, which is
arguably desirable but represents a semantic departure from native SW behavior.

**Scope differences**: `importScripts` integrates with browser devtools for source maps and script
URLs. `eval`'d code can approximate this with a `//# sourceURL=<url>` trailer appended to the
content, but it is not identical.

## Summary of protection coverage

| Scenario                            | Verified?                        | Mechanism                                             |
| ----------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `<script>` tags (SW active)         | Yes                              | SW fetch handler + `respondWith()`                    |
| First page load (no SW yet)         | No                               | Bootstrap trust — platform constraint                 |
| `importScripts` — first install     | Yes (with COOP+COEP)             | SharedWorker + Atomics                                |
| `importScripts` — navigation update | Yes (with COOP+COEP)             | SharedWorker + Atomics                                |
| `importScripts` — background update | No                               | No client present — fire-and-forget                   |
| `importScripts` — no COOP+COEP      | No                               | Fire-and-forget fallback                              |
| `importScripts` — throw-then-retry  | Yes (all cases)                  | Fail install, verify async, eval on retry             |
| `importScripts` — async eval        | Yes (if `'unsafe-eval'` allowed) | async fetch + eval via waitUntil, no TOCTOU, no retry |

## Why deferred

Implementation requires:

1. A persistent SharedWorker with its own script
2. COOP+COEP headers as a hard prerequisite
3. A multistep handshake during SW `install` (clients API, MessageChannel, SAB transfer)
4. Graceful fallback detection (is SharedWorker available? is SAB usable?)

The throw-then-retry and fetch+eval approaches are simpler alternatives that cover more scenarios
without COOP+COEP. The primary remaining tradeoff is eval's `'unsafe-eval'` CSP requirement and the
two-attempt install latency of throw-then-retry.

The security gain is real but bounded — the background update gap and first-load bootstrap gap
remain regardless, and most practical attacks against `importScripts` content fall within the
bootstrap trust boundary already accepted by the threat model.
