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
    integrations: [
        // … other integrations (mdx, sitemap, etc.) …
        dappfence(), // must be last — see Integration ordering below
    ],
});
```

### Integration ordering

**`dappfence` must be the last entry in the `integrations` array.** Its `astro:build:done` hook
walks and hashes the entire output directory, so every other integration that writes files to that
directory (e.g. `@astrojs/sitemap`) must finish first. If `dappfence` runs before another
integration that adds files, those files will be missing from the manifest and the service worker
will block them at runtime.

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

2. **Script tag is injected** on the way to the browser:

    ```html
    <script
        src="/dappfence.js"
        data-manifest="/integrity-manifest.json"
        data-manifest-signature-type="noble-secp256k1-recovered-eth"
        data-manifest-signature-identity="0x..."
    ></script>
    ```

    Two mechanisms cover both output modes:

    - **Prerendered HTML** (any file Astro writes to the output directory): the tag is inserted
      after `<head>` on disk during `astro:build:done`, then the file is hashed.
    - **SSR-rendered HTML** (routes served by the built handler in `output: "server"` or hybrid
      mode): a `pre`-order Astro middleware inserts the tag after `<head>` on every `text/html`
      response. Because the middleware is baked into the compiled `entry.mjs`, both the build-time
      hashing fetch and the runtime request go through it — the response bytes are identical, so the
      manifest hash matches what the browser receives.

3. **`integrity-manifest.json` is generated** — SHA-256 hashes for every tracked file, signed with
   your `secretKey`, written to the output directory.

The integration is a **no-op in `astro dev`**. Vite transforms files at request time so their bytes
never match a static manifest; DappFence is a production-only security layer. Test against the real
build output with `astro preview`.

For details on the manifest format, signature scheme, and verification internals see the
[DappFence README](../../README.md).

## SSR Support

When using `@astrojs/node` in standalone mode, the integration hashes SSR routes at build time by
spinning up the compiled server and fetching them. Routes are handled in three classes:

### fixedRoute — Param-free SSR routes

Routes with no URL parameters (e.g. `/api/version.json`, `/partials/tech-stack`) have a fixed URL
and a deterministic response body. The integration fetches each one and adds its hash to the
manifest automatically — no configuration needed.

### enumerableRoute — Parameterized routes with `getStaticPaths()`

Routes that have URL parameters but declare their full set of valid instances via `getStaticPaths()`
(e.g. `/snippets/[id]`). The integration calls `getStaticPaths()` at build time to enumerate every
concrete path, then hashes each one exactly like a fixedRoute.

```js
// src/pages/snippets/[id].astro
export const prerender = false;

export function getStaticPaths() {
    return [{ params: { id: 'overview' } }, { params: { id: 'api' } }];
}
```

No options or annotations needed — the integration discovers and hashes these automatically.

### probedRoute — Truly dynamic SSR (not supported)

Routes whose output depends on user sessions, database queries, or unbounded query parameters cannot
be hashed at build time. They receive an empty CSP entry (`{ scripts: [], attrs: [] }`) in the
manifest, which blocks all inline scripts on that page. This is a known limitation — see
[Current Limitations](#current-limitations).

### Adapter requirement

SSR hashing (fixedRoute and enumerableRoute) requires the `@astrojs/node` adapter in `standalone`
mode. Other adapters (Vercel, Netlify, Cloudflare) are not supported for SSR hashing — static files
are still fully verified, but SSR routes will receive empty CSP entries only.

```js
import node from '@astrojs/node';

export default defineConfig({
    adapter: node({ mode: 'standalone' }),
    // …
});
```

## Middleware invariants

For SSR mode to work correctly, the response bytes produced by the compiled handler at build time
must match the bytes served at runtime. The DappFence middleware only touches `text/html` responses
(insert bootstrap tag after `<head>`, then step aside). This preserves determinism as long as:

-   **User-installed middleware must not mutate non-HTML response bodies.** Rewriting a JS chunk,
    CSS file, or JSON payload at request time will cause its runtime bytes to diverge from the
    disk-hashed bytes in the manifest, and the SW will block that response. Non-HTML bodies pass
    through the DappFence middleware unchanged for exactly this reason.
-   **HTML responses must be deterministic.** If a middleware inserts a per-request nonce, request
    ID, or timestamp into HTML, the build-time and runtime hashes for that route will differ. Move
    such transformations to a client-side hydration step, or use CSP entries in the manifest to
    permit the varying scripts explicitly.

If either invariant is broken by another middleware in your chain, the failure mode is loud
(response blocked with an integrity violation), not silent.

## Current Limitations

-   **probedRoute SSR (dynamic params without `getStaticPaths`) is not fully supported.** Routes
    whose parameter space cannot be enumerated at build time receive an empty CSP entry — all inline
    scripts on those pages are blocked until hashes are recorded.

-   **Dev server is unprotected.** `astro dev` is intentionally skipped. Security testing must be
    done against `astro build` output served with `astro preview` or a static file server.

-   **Initial load is trusted.** DappFence follows a bootstrap trust model: the initial HTML and
    `dappfence.js` itself are fetched before the service worker is active, so they are not verified
    on the very first page load. All later navigations and asset fetches are verified.
