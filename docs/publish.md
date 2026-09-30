# Publishing and Distribution

## Packages

| Package                     | Directory                 |
| --------------------------- | ------------------------- |
| `@dappfence/core`           | `packages/dappfence`      |
| `@dappfence/manifest-tools` | `packages/manifest-tools` |
| `@dappfence/astro`          | `packages/astro`          |
| `@dappfence/next`           | `packages/next`           |
| `@dappfence/vite`           | `packages/vite`           |

This is also the authoritative allowlist enforced in code: `packages/publish.json`.
`packages/test-app` is never published (internal dev/e2e harness); `packages/netlify` has no
`package.json` (docs only).

---

## Current distribution: .tgz files

Packages are distributed as `.tgz` files built with `npm pack`. All four packages are always
distributed together as a set — consumers install whichever ones they need.

### Building the .tgz files

```bash
npm run publish:local
```

This runs `npm run build:prod` on `@dappfence/core` and then `npm pack` on all publishable packages,
placing the `.tgz` files in `dist/` at the repo root.

### How consumers install them

Consumers place the `.tgz` files in a `vendor/` directory and reference them via `file:` in their
`package.json`:

```json
{
    "dependencies": {
        "@dappfence/core": "file:vendor/dappfence-core-0.1.0.tgz",
        "@dappfence/manifest-tools": "file:vendor/dappfence-manifest-tools-0.1.0.tgz",
        "@dappfence/astro": "file:vendor/dappfence-astro-0.1.0.tgz",
        "@dappfence/vite": "file:vendor/dappfence-vite-0.1.0.tgz"
    }
}
```

### How inter-package dependencies resolve

Integration packages (`@dappfence/astro`, `@dappfence/next`) declare their cross-package
dependencies as `"*"` in a source:

```json
"dependencies": {
    "@dappfence/core": "*",
    "@dappfence/manifest-tools": "*"
}
```

This works correctly in the `.tgz` distribution model: when the consumer installs all packages via
`file:` references in the same `npm install`, npm resolves `"*"` against the `@dappfence/core`
already present in the installation no registry lookup needed. The `"*"` constraint is intentional
and must not be changed to a pinned version in a source.

---

## Version management

MAJOR.MINOR is kept in sync across every publishable package; PATCH moves independently per package.
To bump versions before a `.tgz` build (or before a real release — see below):

```bash
node scripts/sync-versions.js bump-major-minor 0.2 --apply   # every package, resets PATCH to 0
node scripts/sync-versions.js bump-patch @dappfence/vite --apply   # one package's PATCH only
```

This writes `version` directly into the affected `package.json` file(s) on disk. Cross-package `"*"`
dependency ranges are left untouched by design — they're never rewritten, for `.tgz` distribution or
for a real npm publish. See `docs/release-setup.md` for the full versioning policy and the `check`
subcommand CI runs before publishing.

---

## Publishing to npm

Active — see [`docs/release-setup.md`](release-setup.md) for the full setup and release ceremony.
Short version: publishing is automated via `.github/workflows/release.yml`, triggered by a
maintainer pushing an SSH-signed `release-*` tag, gated behind a GitHub Environment approval, and
authenticated to npm via Trusted Publishing (OIDC — no stored token). Manual `npm publish` from a
laptop is a policy violation, not a supported path; see `docs/release-setup.md`'s maintainer
account-hardening section.
