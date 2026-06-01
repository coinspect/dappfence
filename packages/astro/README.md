# @dappfence/astro

Astro integration for [DappFence](../../README.md) — automatically injects the security script and
generates a signed integrity manifest at build time.

## Installation

```bash
npm install @dappfence/astro @dappfence/core
```

`@dappfence/core` provides the `dappfence.js` runtime that gets copied into your build output.

## Setup

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import dappfence from '@dappfence/astro';

export default defineConfig({
    integrations: [dappfence()],
});
```

The integration reads the signing key from the `DAPPFENCE_SECRET_KEY` environment variable
automatically. If the variable is not set and no `secretKey` option is passed, the build fails with
a clear error.

Generate a key once and store it in your CI secrets / `.env` file:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → f0570667f495...
```

```bash
# .env (never commit this file)
DAPPFENCE_SECRET_KEY=f0570667f495...
```

The corresponding Ethereum address (used to verify the manifest signature at runtime) is derived
automatically — you only need to supply the secret key.

### Key resolution order

1. `secretKey` option passed to `dappfence({ secretKey: '…' })` — highest priority
2. `DAPPFENCE_SECRET_KEY` environment variable
3. Neither provided → **build error**

Prefer the environment variable in production, so the key is never committed to source control. The
explicit option is useful for local development fallbacks:

```js
// astro.config.mjs
const DEV_KEY = 'f0570667f495…'; // local dev only, not secret

export default defineConfig({
    integrations: [
        dappfence({
            secretKey: DEV_KEY, // overridden by DAPPFENCE_SECRET_KEY if set
        }),
    ],
});
```

## Options

| Option                      | Type       | Default                                               | Description                                                                                                                                                                         |
| --------------------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secretKey`                 | `string`   | `DAPPFENCE_SECRET_KEY` env var                        | **Required.** Hex secret key (with or without `0x` prefix) used to sign the manifest. Falls back to the `DAPPFENCE_SECRET_KEY` environment variable; build fails if neither is set. |
| `scriptSrc`                 | `string`   | `'/dappfence.js'`                                     | URL path where `dappfence.js` will be served.                                                                                                                                       |
| `manifestUrl`               | `string`   | `'/integrity-manifest.json'`                          | URL path where the manifest will be served.                                                                                                                                         |
| `manifestPath`              | `string`   | `'integrity-manifest.json'`                           | Output filename for the manifest relative to the build output dir.                                                                                                                  |
| `manifestSignatureType`     | `string`   | `'noble-secp256k1-recovered-eth'`                     | Signature algorithm written into the manifest.                                                                                                                                      |
| `manifestSignatureIdentity` | `string`   | derived from `secretKey`                              | Expected signer Ethereum address. Auto-derived if `secretKey` is set.                                                                                                               |
| `mode`                      | `string`   | `'protected'`                                         | Enforcement mode: `'protected'` blocks requests that fail verification; `'reporting'` logs violations without blocking.                                                             |
| `appSW`                     | `string`   | `null`                                                | Path to your app's own service worker, loaded by DappFence via `importScripts()`.                                                                                                   |
| `warningUrl`                | `string`   | `null`                                                | URL shown on the security warning page for tamper alerts.                                                                                                                           |
| `extensions`                | `string[]` | `['.js','.mjs','.css','.html','.htm','.json','.svg']` | File extensions included in the manifest.                                                                                                                                           |
| `exclude`                   | `string[]` | `[]`                                                  | Web paths to exclude from the manifest (e.g. `['/admin']`).                                                                                                                         |

## What Happens at Build Time

Running `astro build` triggers three steps in order:

1. **`dappfence.js` is copied** from `@dappfence/core` into your output directory at `scriptSrc`
   (default `dist/dappfence.js`), so it is served as a first-party file and included in the manifest
   hash.

2. **Script tag is injected** into every HTML file in the output directory:

    ```html
    <script
        src="/dappfence.js"
        data-manifest="/integrity-manifest.json"
        data-manifest-signature-type="noble-secp256k1-recovered-eth"
        data-manifest-signature-identity="0x..."
    ></script>
    ```

3. **`integrity-manifest.json` is generated** — SHA-256 hashes for every tracked file, signed with
   your `secretKey`, written to the output directory.

The integration is a **no-op in `astro dev`**. Vite transforms files at request time so their bytes
never match a static manifest; DappFence is a production-only security layer. Test against the real
build output with `astro preview`.

For details on the manifest format, signature scheme, and verification internals see the
[DappFence README](../../README.md).

## Current Limitations

-   **Static sites only (v1).** This is an initial release. Only files written to disk at build time
    can be hashed and verified. SSR (server-side rendering) is not supported yet — pages rendered on
    demand are outside the verification boundary. SSR support is planned for a future version.

-   **Dev server is unprotected.** `astro dev` is intentionally skipped. Security testing must be
    done against `astro build` output served with `astro preview` or a static file server.

-   **Initial load is trusted.** DappFence follows a bootstrap trust model: the initial HTML and
    `dappfence.js` itself are fetched before the service worker is active, so they are not verified
    on the very first page load. All later navigations and asset fetches are verified.
