# @dappfence/core

Security framework for web applications using service worker content verification and monkey
patching to protect against malicious code execution.

## Usage

```html
<script
    src="/dappfence.js"
    data-manifest="/integrity-manifest.json"
    data-manifest-signature-type="noble-secp256k1-recovered-eth"
    data-manifest-signature-identity="0xAbC123..."
    data-app-sw="sw_app.js"
></script>
```

The framework detects its execution context automatically: in a browser it registers and manages the
security service worker; in a service worker it intercepts fetch events and verifies file integrity.

## Scripts

```bash
npm run build          # Development build (dist/dappfence.js)
npm run build:prod     # Production build (minified, obfuscated)
npm run build:watch    # Rebuild on source changes
npm test               # Run unit tests
npm run test:coverage  # Unit tests with coverage report
npm run clean          # Remove dist/ and coverage/
```

## Source Structure

```
src/
├── main.js              # Entry point — context detection, routes to client or SW
├── core/                # Shared utilities
│   ├── crypto.js        # SHA-256 hashing, secp256k1 signature recovery
│   ├── logger.js        # Conditional logging
│   ├── monkey-patch.js  # Generic monkey-patching utility
│   └── utils.js         # Hash helpers, config checks
├── client/              # Browser context
│   ├── sw-registration.js  # Smart SW registration, Shift+Reload handling
│   └── security-handler.js # Client-side security event handling
├── sw/                  # Service worker context
│   ├── main.js          # SW entry, event registration
│   ├── services.js      # Factory wiring all dependencies
│   ├── context.js       # SW global scope wrapper (testable interface)
│   ├── fetch-handler.js # Main request interceptor
│   ├── api-handler.js   # /sw-api/* endpoints (status, warnings, unblock)
│   ├── lifecycle-handlers.js  # install/activate handlers
│   ├── appsw-hooks.js   # importScripts/addEventListener monkey-patches
│   ├── message-broker.js     # Security message queuing to clients
│   ├── response.js      # Block response and navigation redirect builders
│   ├── manifest/
│   │   ├── manifest-service.js  # Composition: loader + verifier
│   │   ├── manifest-loader.js   # Fetching, signature verification, normalization, storage handoff
│   │   ├── verifier.js          # Hash-every-response + pathRules key resolution + escalation walk
│   │   ├── rules.js             # pathRules evaluation (resolveManifestKey)
│   │   └── verification.js      # verifyManifestSignature, verifyLocation, verifyImportedScript, toPathname
│   ├── storage/
│   │   ├── indexeddb.js       # Low-level IndexedDB wrapper
│   │   ├── index.js           # App store facade (recordSecurityViolation)
│   │   ├── manifest-store.js  # App version, trusted manifests, verification results
│   │   └── security-stores.js # Active blocks, security events, API tokens
│   └── __tests__/       # Unit tests (vitest)
└── templates/           # Security warning HTML/CSS
```

## Service Worker Architecture

### Module Dependency Graph

```
main.js
  └── services.js (creates and wires all dependencies)
        ├── context.js
        ├── storage/
        │     ├── indexeddb.js
        │     ├── index.js (appStore facade)
        │     ├── manifest-store.js
        │     └── security-stores.js
        ├── manifest/
        │     ├── manifest-service.js (composition: loader + verifier)
        │     ├── manifest-loader.js (fetch, verify signature, normalize, hand to store)
        │     ├── verifier.js (hash-every-response + escalation walk)
        │     ├── rules.js (pathRules — resolveManifestKey)
        │     └── verification.js (verifyManifestSignature, verifyLocation, verifyImportedScript)
        ├── message-broker.js
        ├── appsw-hooks.js
        ├── fetch-handler.js
        │     └── api-handler.js (created internally by fetch-handler)
        └── lifecycle-handlers.js
```

### Entry Point inside

**`main.js`** initializes the service worker by calling `createServices(self)` and registering event
handlers on the hook service. Contains no dependency creation logic.

**`services.js`** is the factory that creates and wires all dependencies. Accepts `swGlobal` (the
raw `self`), making it testable with a mock global. Returns
`{ hookService, fetchHandler, installHandler, activateHandler, messageHandler }`.

### Core Infrastructure

**`context.js`** wraps the SW global scope behind a testable interface: `fetch`, `location`,
`clients`, `skipWaiting`, `navigator.userAgent`.

**`appsw-hooks.js`** monkey-patches `importScripts` and `addEventListener` to intercept app SW
operations. Receives an `onVerifyScript(scriptPath)` callback — no knowledge of manifest or storage.

**`response.js`** provides pure functions for creating block responses and navigation warning
redirects.

### Event Handlers

All handlers receive a shared `core` object:
`{ swContext, appStore, manifestService, onSecurityViolation }`.

-   **`fetch-handler.js`** — main request interceptor. Checks active blocks, routes `/sw-api/*` to
    the API handler, verifies assets via the ctx returned by `manifestService.resolveManifest`,
    broadcasts violations.
-   **`lifecycle-handlers.js`** — `install` initializes the manifest, loads the app SW via
    `importScripts`, signals `onInstallDone`. `activate` claims clients and re-broadcasts
    violations.
-   **`api-handler.js`** — handles `/sw-api/*` endpoints (status, security-warning page, block
    details, site unblock).
-   **`message-broker.js`** — queues and delivers security messages to clients. Handles
    `CLAIM_CONTROL` and `DAPPFENCE_CLIENT_READY` messages.

### Manifest System

`VERIFICATION_STATUS` and `ASSET_TYPE` constants live in `core/constants.js` alongside the other
cross-module contract strings.

**`manifest/verification.js`** contains pure verification primitives: `verifyManifestSignature`
(secp256k1 recovery), `toPathname` / `decodePathname` (URL → manifest key), `verifyLocation` (fetch
and verify), `verifyImportedScript` (delegates to `verifyLocation`, records violations).

**`manifest/rules.js`** evaluates pathRules — `resolveManifestKey(req, base, manifest, response)`
applies `directory-index`, `html-extension`, `match`/`resolveAs`, and last-resort `error-page` rules
to map a request URL to its canonical manifest key.

**`manifest/manifest-loader.js`** owns the boundary between raw external manifest JSON and the
normalized in-memory shape: `normalizeManifestData` (files → hash arrays, pathRules default, mode
default), `fetchAndStoreManifest` (single-flight fetch → signature verify → normalize →
`trustedManifestStore.addLatest`), `resolveLatest` (cache-first + fallback fetch), and
`getManifestHistory` (delegates to the store).

**`manifest/verifier.js`** exports `createVerifier` — hashes every verifiable response and matches
against the manifest's `files` map. Uses pathRules to canonicalize URL → manifest key
(`directory-index`, `error-page`, etc.). Owns the escalation walk (pinned → latest → history →
network), per-client pinning with stale-client pruning, and gate checks (`shouldSkipVerification` —
non-GET, `destination=""`, opaque REWRITE branch). Returns verdicts with a `status` field (`MATCH`,
`MISMATCH`, `NOT_FOUND_IN_MANIFEST`, `SKIPPED`, `REWRITE`).

**`manifest/manifest-service.js`** composes the loader and the verifier. Exposes
`{ fetchAndStoreManifest, resolveManifest }`; `resolveManifest()` returns
`{ mode, prepareRequest, verifyResponse }`.

### Storage

-   **`storage/indexeddb.js`** — low-level IndexedDB wrapper: `{ get, set, delete, withTx }`.
-   **`storage/index.js`** — app store facade. Composes all stores, exposes
    `recordSecurityViolation(details)`.
-   **`storage/manifest-store.js`** — trusted manifests (newest-first priority queue, 24h age
    pruning, MAX 20 safety cap) and verification results (per-version, capped at 100).
-   **`storage/security-stores.js`** — active blocks (deterministic IDs), security events, API
    tokens.

## Integrity Manifest

The manifest structure follows the [Coze specification](https://github.com/Cyphrme/Coze). It
consists of a signed JSON document with a `pay` (payload) and `sig` (signature) field. The payload
contains a `files` map of file paths to their SHA-256 hashes. Signature verification uses
Ethereum-style secp256k1 key recovery.

### Why a Centralized Manifest

-   **vs. SRI**: SRI is designed for external resources and scripts. We need to validate all
    resource types (HTML, CSS, JS, images) consistently.
-   **vs. per-file signatures**: A centralized manifest is easier to integrate across environments.
    Per-file signatures would require modifying every file and implementing validation for each
    type.
-   **vs. hashes alone**: A manifest includes metadata and provides a clear overview of all
    validated resources in one place.

### Manifest Lifecycle

1. At build time, `@dappfence/manifest-tools` hashes all files and signs the manifest payload.
2. At runtime, `manifest-loader.js` fetches the manifest, verifies the signature, normalizes it, and
   stores it in IndexedDB.
3. Subsequent file requests flow through `ctx.verifyResponse`, where the active verifier variant
   hashes the response and walks the escalation chain against stored manifests.

## Design Patterns

-   **Callbacks over objects** — modules receive focused callbacks (`onSecurityViolation`,
    `onInstallDone`, `onVerifyScript`) instead of full service objects.
-   **Shared `core` deps** — `{ swContext, appStore, manifestService, onSecurityViolation }` bundled
    and spread into handlers.
-   **`swContext` wraps all globals** — no module touches `self` directly except `appsw-hooks.js`
    (monkey-patching) and `main.js` (passes `self` to `createServices`).
-   **`appStore` as facade** — all storage access goes through `appStore`, which provides
    `recordSecurityViolation` as the single entry point.
-   **Consistent result shape** — all verification functions return `{ status, ... }` using
    `VERIFICATION_STATUS` constants. Error paths return result objects (never `undefined`).
