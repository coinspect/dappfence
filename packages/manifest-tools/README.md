# @dappfence/manifest-tools

Core build-time tooling for [DappFence](../../README.md) — file hashing, manifest signing, directory
walking, and script tag injection. Used internally by framework integrations and available as a
standalone CLI for custom integrations.

## Installation

```bash
npm install @dappfence/manifest-tools
```

## CLI

After installation, the `dappfence-manifest` binary is available.

### `hash` — print SHA-256 of one or more files

```bash
dappfence-manifest hash dist/app.js dist/style.css
# dist/app.js
#   hex: 3a4f2b...
#   sri: sha256-Ok8r...
# dist/style.css
#   hex: 8c1d9f...
#   sri: sha256-jB3p...
```

### `verify` — verify a manifest's signature

```bash
dappfence-manifest verify out/integrity-manifest.json
# ✓ valid — signed by 0xAbC123...
```

### `sign` — generate a signed manifest from a directory

Walks the directory, injects the dappfence script tag into every HTML file, hashes all tracked
files, signs, and writes `integrity-manifest.json`.

```bash
dappfence-manifest sign ./out --secret-key <hex>
```

Generate a key once and store it in your CI secrets / `.env` file:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → f0570667f495...
```

```bash
# .env (never commit this file)
DAPPFENCE_SECRET_KEY=f0570667f495...
```

The key can also be passed via the `DAPPFENCE_SECRET_KEY` environment variable instead of
`--secret-key`.

#### Options for `sign`

| Option           | Default                    | Description                                     |
| ---------------- | -------------------------- | ----------------------------------------------- |
| `--secret-key`   | `DAPPFENCE_SECRET_KEY` env | Hex signing key (with or without `0x` prefix)   |
| `--out`          | `integrity-manifest.json`  | Output manifest path, relative to `<dir>`       |
| `--script-src`   | `/dappfence.js`            | Public URL where `dappfence.js` is served       |
| `--manifest-url` | `/integrity-manifest.json` | Public URL where the manifest is served         |
| `--mode`         | `protected`                | `protected` (blocks) or `reporting` (logs only) |
| `--no-inject`    | —                          | Skip script tag injection into HTML files       |
| `--ext`          | `.js,.mjs,.css,.html,...`  | Comma-separated file extensions to include      |
| `--exclude`      | —                          | Comma-separated web path prefixes to exclude    |

## Programmatic API

### `calculateFileHash(input)` → `string`

Returns an SRI hash (`sha256-<base64>`) for a file buffer or path.

```js
const { calculateFileHash } = require('@dappfence/manifest-tools');
const hash = calculateFileHash('/path/to/file.js');
// → 'sha256-Ok8r...'
```

### `signManifest(payload, { secretKey })` → `object`

Signs a manifest payload and returns `{ pay, sig, identity, signatureType }`.

```js
const { signManifest } = require('@dappfence/manifest-tools');
const manifest = signManifest({ files: { ... }, mode: 'protected', metadata: { ... } }, { secretKey });
```

### `verifyManifest(manifestPath)` → `{ identity }`

Verifies the signature on a manifest file against its embedded `identity`. Throws if unsigned or
signature does not match.

```js
const { verifyManifest } = require('@dappfence/manifest-tools');
const { identity } = verifyManifest('./out/integrity-manifest.json');
```

### `deriveIdentity(secretKeyHex)` → `string`

Derives the Ethereum signer address from a secret key.

```js
const { deriveIdentity } = require('@dappfence/manifest-tools');
const address = deriveIdentity(process.env.DAPPFENCE_SECRET_KEY);
// → '0xAbC123...'
```

### `generateManifest(opts)` (async) — from `@dappfence/manifest-tools/manifest`

Walks a directory, optionally injects the dappfence script tag into HTML pages, hashes all tracked
files, and writes a signed manifest.

```js
const { generateManifest } = require('@dappfence/manifest-tools/manifest');

await generateManifest({
    outDir: '/path/to/out',
    manifestPath: 'integrity-manifest.json',
    secretKey: process.env.DAPPFENCE_SECRET_KEY,
    mode: 'protected',
    scriptAttrs: { scriptSrc: '/dappfence.js', manifestUrl: '/integrity-manifest.json' },
    logger: console,
});
```

### `buildScriptAttrs(opts)` / `buildScriptTag(opts)` — from `@dappfence/manifest-tools/manifest`

Returns the script tag attributes as a plain object or as an HTML string. Framework-agnostic — use
whichever form your framework expects.

```js
const { buildScriptAttrs, buildScriptTag } = require('@dappfence/manifest-tools/manifest');

// Plain object — works with React, Vue, Svelte, etc.
const attrs = buildScriptAttrs({
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
});
// → { src: '/dappfence.js', 'data-manifest': '/integrity-manifest.json', ... }

// HTML string — for direct injection into HTML files
const tag = buildScriptTag({ scriptSrc: '/dappfence.js', manifestUrl: '/integrity-manifest.json' });
// → '<script src="/dappfence.js" data-manifest="..."></script>'
```
