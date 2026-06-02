# @dappfence/next

Next.js integration for [DappFence](../../README.md) — automatically copies the security script,
hashes static assets, and generates a signed integrity manifest at build time.

## Installation

```bash
npm install @dappfence/next @dappfence/core
```

`@dappfence/core` provides the `dappfence.js` runtime copied into your output.

## Setup

### SSR / hybrid apps (default Next.js mode)

Wrap your Next.js config with `withDappfence`:

```js
// next.config.js
import { withDappfence } from '@dappfence/next';

export default withDappfence({
    secretKey: process.env.DAPPFENCE_SECRET_KEY,
})(nextConfig);
```

Then add the script tag to your root layout. Use Next.js's built-in `<Script>` component with
`strategy="beforeInteractive"` so DappFence loads before any other scripts on the page.
`getDappfenceScriptAttrs` supplies all required attributes from the build-time config — no options
or secrets are needed in the layout:

```jsx
// app/layout.js
import Script from 'next/script';
import { getDappfenceScriptAttrs } from '@dappfence/next';

const { src, ...attrs } = getDappfenceScriptAttrs();

export default function RootLayout({ children }) {
    return (
        <html>
            <head>
                <Script src={src} strategy="beforeInteractive" {...attrs} />
            </head>
            <body>{children}</body>
        </html>
    );
}
```

`strategy="beforeInteractive"` ensures DappFence is executed before any other JavaScript, which is
required for the service worker registration and monkey-patching to take effect. The private key
never appears here — `getDappfenceScriptAttrs` reads only the public signer address and URLs baked
into the build by `withDappfence`.

### Static export (`output: 'export'`)

Add a `postbuild` script — npm runs it automatically after `next build`:

```jsonc
// package.json
{
    "scripts": {
        "build": "next build",
        "postbuild": "dappfence-next",
    },
}
```

The `dappfence-next` CLI reads the config written by the webpack plugin during `next build`, then
injects the script tag into every HTML file in `out/`, hashes all tracked files, and writes a signed
manifest. See [Key Management](#key-management) below for how to generate and provide the signing
key.

### Key resolution order

1. `secretKey` option passed to `withDappfence({ secretKey: '…' })` — highest priority
2. `DAPPFENCE_SECRET_KEY` environment variable

## Key Management

DappFence signs the integrity manifest with a secp256k1 private key. The signer's Ethereum address
is derived from this key and embedded in the manifest; the service worker uses it to verify the
signature at runtime. Anyone with the private key can produce a valid manifest, so treat it like a
deploy secret.

### Generating a key

Run this once and save the output somewhere safe:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → f0570667f495...
```

### Local development

Add the key to a `.env.local` file (never commit this):

```bash
# .env.local
DAPPFENCE_SECRET_KEY=f0570667f495...
```

Next.js automatically loads `.env.local`, so `process.env.DAPPFENCE_SECRET_KEY` will be set when you
run `next build`.

### CI / production

Store the key as a repository secret (GitHub Actions, GitLab CI, etc.) and expose it as an
environment variable in your build step:

```yaml
# .github/workflows/deploy.yml
- name: Build
  run: npm run build
  env:
      DAPPFENCE_SECRET_KEY: ${{ secrets.DAPPFENCE_SECRET_KEY }}
```

Because `withDappfence` falls back to `process.env.DAPPFENCE_SECRET_KEY` automatically, no change to
`next.config.js` is needed between local and CI environments.

### Where the key is used

The private key is needed in one place only: the environment where `next build` runs.

-   **`withDappfence` in `next.config.js`** reads the key, derives the public signer address, signs
    the manifest, then discards the key.
-   **`getDappfenceScriptAttrs()` in your layout** reads only the derived public address from
    `.next/dappfence-attrs.json` — a file written by the webpack plugin that contains no secrets.
    The key itself is never written to disk.

For static exports the `dappfence-next` CLI also reads `DAPPFENCE_SECRET_KEY` directly from the
environment at postbuild time — it is not stored in the build config file.

### Key is never on disk

DappFence intentionally avoids persisting the private key anywhere:

-   `.next/dappfence-attrs.json` — public signer address and URLs only; safe if accidentally
    committed
-   `.next/dappfence-config.json` — build options for the static export CLI; no secret key
-   `out/` / `public/` — served files; no secrets

```bash
# .gitignore — still good practice to exclude the .next directory
.next/
```

## Options

| Option                      | Type       | Default                                               | Description                                                                                                                                                                         |
| --------------------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secretKey`                 | `string`   | `DAPPFENCE_SECRET_KEY` env var                        | Hex secret key (with or without `0x` prefix) used to sign the manifest. Falls back to the `DAPPFENCE_SECRET_KEY` environment variable. Manifest is unsigned if neither is provided. |
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

### SSR mode

After the client webpack compilation completes:

1. **`dappfence.js` is copied** from `@dappfence/core` into `public/` so Next.js serves it at the
   root (default `public/dappfence.js` → `/dappfence.js`).

2. **`integrity-manifest.json` is generated** — SHA-256 hashes for all static assets under
   `.next/static/`, signed with your `secretKey`, written to `public/`. HTML is excluded because it
   is rendered server-side and changes per request.

### Static export mode (`output: 'export'`)

After `next build` completes, `dappfence-next` (`postbuild`):

1. **`dappfence.js` is copied** into `out/`.
2. **Script tag is injected** into every HTML file in `out/`.
3. **`integrity-manifest.json` is generated** — SHA-256 hashes for every tracked file in `out/`,
   signed, written to `out/`.

## Current Limitations

-   **SSR pages are not hashed.** HTML generated on demand cannot be hashed at build time. Only
    static assets (JS, CSS, etc.) under `/_next/static/` are included in the manifest for SSR apps.
    Script tag injection into HTML must be done manually via your root layout. SSR page verification
    support is planned for a future version.

-   **Dev server is unprotected.** The webpack plugin is a no-op during `next dev`. Security testing
    must be done against the production build output.

-   **Initial load is trusted.** DappFence follows a bootstrap trust model: the initial HTML and
    `dappfence.js` itself are fetched before the service worker is active, so they are not verified
    on the very first page load. All later navigations and asset fetches are verified.
