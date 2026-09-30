# @dappfence/vite

Vite plugin for [DappFence](../../README.md) — automatically injects the security script and
generates a signed integrity manifest at build time, for plain Vite SPA/MPA builds with static HTML
output.

**Scope:** meta-frameworks built on Vite (Astro, Next.js, SvelteKit, Nuxt, Remix, …) have their own
output layout and SSR routes and are not covered here — use [`@dappfence/astro`](../astro) or
[`@dappfence/next`](../next) for those instead.

## Installation

```bash
npm install @dappfence/vite @dappfence/core
```

`@dappfence/core` provides the `dappfence.js` runtime that gets copied into your build output.

## Setup

```js
// vite.config.js
import { defineConfig } from 'vite';
import dappfence from '@dappfence/vite';

export default defineConfig({
    plugins: [
        react(), // … other plugins …
        dappfence(), // should be listed last — see Plugin ordering below
    ],
});
```

### Plugin ordering

**`dappfence` should be the last entry in the `plugins` array.** Its `closeBundle` hook walks and
hashes the entire output directory after Vite has written the build, so any other plugin that writes
extra files into `outDir` (e.g. a static-copy plugin) should run first. The plugin also sets
`enforce: 'post'`, which pushes its own build hooks to run after normal/pre-enforced plugins — but
explicit ordering in the array is the more reliable guarantee.

The plugin only runs during `vite build` (`apply: 'build'`); it is a no-op under `vite dev` for the
same reason `@dappfence/astro` skips `astro dev` — Vite transforms files at request time, so their
bytes never match a static manifest. Test against the real build with `vite preview`.

The plugin reads the signing key from the `DAPPFENCE_SECRET_KEY` environment variable automatically.
If neither that nor the `secretKey` option is set, the build fails with a clear error — see
[Key resolution order](../astro/README.md#key-resolution-order) in the astro package docs (same
behavior here).

## Options

| Option                             | Type                | Default                           | Description                                                                                            |
| ---------------------------------- | ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `secretKey`                        | `string`            | `DAPPFENCE_SECRET_KEY` env        | **Required.** Hex secret key used to sign the manifest.                                                |
| `scriptSrc`                        | `string`            | `'/dappfence.js'`                 | URL path where `dappfence.js` will be served.                                                          |
| `manifestUrl`                      | `string`            | `'/integrity-manifest.json'`      | URL path where the manifest will be served.                                                            |
| `manifestPath`                     | `string`            | `'integrity-manifest.json'`       | Output filename for the manifest relative to `outDir`.                                                 |
| `manifestSignatureType`            | `string`            | `'noble-secp256k1-recovered-eth'` | Signature algorithm written into the manifest.                                                         |
| `manifestSignatureIdentity`        | `string`            | derived from `secretKey`          | Expected signer Ethereum address.                                                                      |
| `mode`                             | `string`            | `'protected'`                     | `'protected'` blocks requests that fail verification; `'reporting'` logs violations without blocking.  |
| `appSW`                            | `string`            | `null`                            | Path to your app's own service worker, loaded via `importScripts()`.                                   |
| `warningUrl`                       | `string`            | `null`                            | URL shown on the security warning page for tamper alerts.                                              |
| `exclude`                          | `string[]`          | `[]`                              | Web paths to exclude from the manifest.                                                                |
| `pageFilter`                       | `Function`          | extension-based + `spaFallback`   | `(webPath, ext) => bool`; overrides the default page-matching used for script injection entirely.      |
| `spaFallback`                      | `string[]`          | `[]`                              | Extensionless routes (e.g. `['/btc', '/baby']`) to receive a copy of `spaFallbackSource`.              |
| `spaFallbackSource`                | `string`            | `'index.html'`                    | File (relative to `outDir`) copied to each `spaFallback` route.                                        |
| `csp`, `pathRules`, `contentRules` | `object`/`object[]` | —                                 | Passed through to `generateManifest` — see [`@dappfence/manifest-tools`](../manifest-tools) for shape. |

## SPA-fallback routes

A client-side router (e.g. `react-router`) serves every route from the same `index.html`, but a
direct hit or hard refresh on a route like `/btc` needs the static host to actually return that HTML
file for that URL. Hosts with a catch-all SPA rewrite (`/* → /index.html`) handle this automatically
and `spaFallback` is not needed.

Without such a rewrite, `spaFallback` writes physical copies of `spaFallbackSource` at each listed
route **before** hashing — so they get the bootstrap script tag injected and are tracked in the
manifest exactly like any other page, with no separate postbuild copy step:

```js
dappfence({
    secretKey: process.env.DAPPFENCE_SECRET_KEY,
    spaFallback: ['/btc', '/baby', '/rewards'],
});
```

This replaces a manual `cp dist/index.html dist/btc` (etc.) step run between `vite build` and
signing — that ordering matters: any such copy has to exist before the manifest is generated, or the
copied file is missing from the manifest and the service worker will block it at runtime.

## What Happens at Build Time

Running `vite build` triggers, in order, on `closeBundle`:

1. **`dappfence.js` is copied** from `@dappfence/core` into `outDir` at `scriptSrc` (default
   `dist/dappfence.js`).
2. **`spaFallback` routes are written**, if configured.
3. **Script tag is injected** into every HTML page and fallback route.
4. **`integrity-manifest.json` is generated** — SHA-256 hashes for every tracked file, signed with
   your `secretKey`, written to `outDir`.

For details on the manifest format, signature scheme, and verification internals see the
[DappFence README](../../README.md).

## Current Limitations

-   **Static output only.** SSR/hybrid Vite setups (Astro, Next.js, SvelteKit, Nuxt, Remix, …) are
    out of scope — use the dedicated integration for that framework.
-   **Dev server is unprotected.** `vite dev` is intentionally skipped; test against `vite build` +
    `vite preview`.
