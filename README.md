# DappFence: Verifiable Web Frontends

An open-source client-side security layer that cryptographically verifies frontend code before
execution, preventing frontend compromise attacks.

## The Problem

Web application frontends are fragile single points of failure. DNS hijacks, CDN breaches, and
malicious dependencies are weaponizing trusted interfaces into attack vectors. Users blindly trust
dynamic websites loaded with vulnerable third-party code — one compromised asset is all it takes to
steal credentials, exfiltrate data, or execute unauthorized actions.

This is especially critical for applications that handle sensitive operations: financial platforms,
crypto wallets, admin dashboards, healthcare portals — anywhere a tampered UI can cause real damage.
Users act based on what a frontend shows them, but have no way to verify the frontend itself is
legitimate.

## What DappFence Does

DappFence cryptographically verifies every file served to the browser before execution. If anything
has been tampered with — whether through DNS hijacking, CDN compromise, or a malicious CI/CD
dependency — DappFence blocks it and alerts the user.

-   A **signed integrity manifest** contains SHA-256 hashes of all files, signed with secp256k1
    (Ethereum-compatible)
-   A **security service worker** intercepts all fetch requests
-   Every file is **verified against the manifest** before execution
-   Modified files trigger **automatic blocking** with clear security warnings

No framework changes. No performance impact. Designed to work with React, Vue, vanilla JS —
anything. Integration is a single script tag.

## Current Status

Phase 1 is complete and working:

-   SHA-256 verification with automatic blocking (403 + security warning)
-   Service worker interception preventing unauthorized SW registration
-   Ethereum-compatible manifest signatures (secp256k1)
-   Multi-tab violation broadcasting
-   Token-based API security for security endpoints
-   Persistent security events with occurrence tracking
-   Full E2E test coverage; domain takeover survivability tested

## Quick Start

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd dappfence

# Install dependencies
npm install

# Start the development server with example app
npm run dev
```

### Usage

1. **Copy `dappfence.js` to your web server root directory**

    This is the built output file from `packages/dappfence/dist/dappfence.js`.

2. **Add DappFence as the first script in your application's HTML**:

    ```html
    <!-- Load DappFence security protection -->
    <script src="/dappfence.js"></script>
    ```

    Important: Load DappFence before any other JavaScript to ensure complete protection.

3. **Configure DappFence options**:

    ```html
    <script
        src="/dappfence.js"
        data-manifest="/integrity-manifest.json"
        data-manifest-signature-type="noble-secp256k1-recovered-eth"
        data-manifest-signature-identity="0xAbC123..."
        data-app-sw="sw_app.js"
    ></script>
    ```

    | Attribute                          | Required | Description                                                                                                        |
    | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
    | `data-manifest`                    | Yes      | Path to the signed integrity manifest containing file hashes.                                                      |
    | `data-manifest-signature-type`     | Yes      | Signature algorithm used to sign the manifest. Currently supported: `noble-secp256k1-recovered-eth`.               |
    | `data-manifest-signature-identity` | Yes      | Expected signer address (Ethereum address) used to verify the manifest signature.                                  |
    | `data-app-sw`                      | No       | Path to the application's own service worker. DappFence will load it via `importScripts()` inside the security SW. |

## Repository Structure

This is a monorepo with four packages. Each has its own README with detailed documentation:

-   [`packages/dappfence`](packages/dappfence/README.md) — core framework architecture, module
    descriptions, manifest format, and design patterns
-   [`packages/astro-integration`](packages/astro-integration/README.md) — Astro integration: script
    injection, manifest generation, dynamic content tagging
-   [`packages/test-app`](packages/test-app/README.md) — test scenarios, dev server configuration,
    and libfaketime setup for cache expiration testing
-   [`packages/signer`](packages/signer/) — manifest signing library (`signManifest`,
    `calculateFileHash`)

```
dappfence/
├── packages/
│   ├── dappfence/                # Core security framework
│   │   ├── src/
│   │   │   ├── main.js           # Entry point with context detection
│   │   │   ├── core/             # Crypto, logging, monkey-patching, utilities
│   │   │   ├── client/           # Client-side SW registration & lifecycle
│   │   │   ├── sw/               # Service worker security layer
│   │   │   │   ├── manifest/     # Manifest verification & service
│   │   │   │   ├── storage/      # IndexedDB stores (blocks, events, tokens)
│   │   │   │   └── __tests__/    # Unit tests
│   │   │   └── templates/        # Security warning HTML/CSS
│   │   ├── vite.config.js        # Build configuration
│   │   └── feature_flag.json     # Feature toggles per environment
│   └── test-app/                 # Development & testing harness
│       ├── src/                  # Dev server, build scripts
│       ├── test/                 # Playwright end-to-end tests
│       ├── template/             # Example app HTML templates
│       └── dist/                 # Built test app variants
├── eslint.config.js              # ESLint configuration
├── .prettierrc                   # Prettier configuration
└── package.json                  # Root scripts, dependencies
```

## Development

### Root Scripts

-   `npm run dev` - Build all packages and start the dev server with browser
-   `npm test` - Build all packages, then run unit tests and e2e tests
-   `npm run build` - Build all packages (core + test-app manifests)
-   `npm run build:prod` - Production build of `@dappfence/core` (minified, obfuscated)
-   `npm run build:watch` - Watch mode: auto-rebuild core + manifests on source changes
-   `npm run clean` - Remove all build output from every package
-   `npm run publish:local` - Build production bundle and pack `@dappfence/core` as a tarball to
    `dist/` for use by local examples
-   `npm run check` - Run linting and formatting checks
-   `npm run lint` - Run ESLint with auto-fix
-   `npm run format` - Format code with Prettier

### Per-Package Scripts

Run any package script from the root with `-w`:

```bash
npm run test:coverage -w @dappfence/core  # Unit tests with coverage
npm run dev:http -w @dappfence/test-app   # Dev server without browser
npm run test:headed -w @dappfence/test-app # E2e tests in headed browser
npm run test:debug -w @dappfence/test-app  # Debug e2e tests
```

### Local Examples

The `examples/` directory contains standalone apps. They reference monorepo packages via `file:`
symlinks so changes are picked up immediately without a pack/install cycle.

```bash
# Install dependencies in the example (run from the example directory)
cd examples/astro
npm install

# Build and preview
npm run build
npm run preview
```

If you change any `packages/*` source, rebuild the relevant package before re-running the example:

```bash
# From repo root — rebuild core (required when dappfence.js source changes)
npm run build -w @dappfence/core
```

### Development Requirements

-   Node.js 16.0.0 or higher
-   Modern browser with service worker support

### Note on `@dappfence/test-app`

`@dappfence/test-app` is a `private` package that only runs within this monorepo. Its `dev` and
`dev:http` scripts require `@dappfence/core` to be built first (the dist must exist). When running
from the root, `npm run dev` and `npm test` handle this automatically by building all packages
first.

## How It Works

### How Verification Works

1. A signed manifest is generated at build time containing SHA-256 hashes of all frontend files
2. DappFence registers a security service worker that intercepts all fetch requests
3. Every file is verified against the manifest hashes before the browser executes it
4. If a file has been tampered with, DappFence blocks it with a 403 response and shows a security
   warning page

### Architecture

DappFence uses a three-layer security approach:

1. **Client-Side Protection** (`dappfence.js` in browser context):

    - Monkey patches `navigator.serviceWorker.register()`
    - Ensures security service worker loads first
    - Manages service worker lifecycle

2. **Security Service Worker** (`dappfence.js` in SW context):

    - Intercepts all fetch events
    - Performs SHA-256 content verification for requests
    - Stores trusted content hashes in IndexedDB

3. **Application Service Worker**:
    - Loaded through `importScripts()` in the security SW context
    - Provides normal app functionality
    - All requests pass through the security layer first

### Security Flow (Integrity Verification)

1. **Initialization**: Client loads and DappFence registers security service worker
2. **SW Interception**: Security SW intercepts app SW registration and loads it via
   `importScripts()`
3. **Verification Phase**: Subsequent loads verify files against trusted hashes
4. **Security Response**: Modified files trigger user-friendly blocking
5. **Graceful Degradation**: Apps remain functional with clear security messaging

## Development Server

The test-app package includes a dev server that serves the built `dappfence.js` and example apps.
Playwright uses this same server for e2e tests.

```bash
# Quick start: build everything and open browser
npm run dev
```

For active development, use watch mode with the dev server in a separate terminal:

```bash
# Terminal 1 — auto-rebuild on source/template/asset changes
npm run build:watch

# Terminal 2 — dev server (serves files fresh on each request)
npm run dev:http -w @dappfence/test-app
```

This gives you a full live-reload workflow: edit dappfence source, templates, assets, and the
manifests are regenerated automatically. The dev server reads files on each request, so changes are
picked up immediately.

The server runs on `http://localhost:3333` by default (or pass `-p 8080` for a custom port). The app
and version are configurable via the test-app API, which is how Playwright selects which app variant
to test. When running in dev mode, the app is fixed by `-d simple-app_latest`.

## Running E2E Tests

You must build before running e2e tests since they need the compiled `dappfence.js` and signed
manifests.

1. **From the root** (recommended): builds all packages, then runs unit tests and e2e:

    ```bash
    npm test
    ```

2. **E2e only** (when you've already built):

    ```bash
    npm test -w @dappfence/test-app
    ```

    Playwright automatically starts the dev server via `npm run dev:http` in the test-app package.

3. **Manual mode** (for debugging):

    ```bash
    # Terminal 1 - Start the dev server (logs all requests)
    npm run dev:http -w @dappfence/test-app

    # Terminal 2 - Run tests against the running server
    SKIP_WEBSERVER=1 npm test -w @dappfence/test-app
    ```

    This is useful when you need to trace server logs, keep the server running between test runs, or
    manually inspect the test application in a browser.

**Test Coverage:**

-   Service worker registration and lifecycle
-   File integrity verification (index.html, dappfence.js, app.js)
-   Security warning page generation for modified files
-   Manifest payload integrity validation
-   Multi-tab security violation broadcasting

## Security Considerations

-   **Initial Trust**: The security model assumes the initial HTML/JS loading is trusted
-   **HTTPS Required**: Service workers require HTTPS in production (localhost HTTP is OK)
-   **Content Security Policy**: Monkey patching may require CSP adjustments
-   **Browser Support**: Requires modern browsers with service worker and IndexedDB support

## License

This project is licensed under the MIT License.
