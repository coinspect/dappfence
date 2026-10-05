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

Packages are distributed as `.tgz` files built with `npm pack`. All five packages are always
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

Integration packages (`@dappfence/astro`, `@dappfence/next`, `@dappfence/vite`) declare their
cross-package dependencies as the generation range `~X.Y.0`:

```json
"dependencies": {
    "@dappfence/core": "~0.1.0",
    "@dappfence/manifest-tools": "~0.1.0"
}
```

`~0.1.0` means `>=0.1.0 <0.2.0` — any PATCH from the same MAJOR.MINOR line, nothing from the next.
`sync-versions.js` maintains these; don't edit them by hand.

This works in the `.tgz` distribution model: when the consumer installs all packages via `file:`
references in the same `npm install`, the `@dappfence/core` already present satisfies `~0.1.0`, so
npm uses it with no registry lookup — the packages are distributed as a set from one generation, so
the range is always satisfied locally.

These used to be `"*"`. That also resolved locally, but it published no constraint at all, so a
consumer installing `@dappfence/astro` from npm got whatever `core` was `latest` that day — a
future, incompatible major included. `packages/test-app` keeps `"*"`: it is private and never
published, so its ranges only need to satisfy local workspace linking.

---

## Version management

MAJOR.MINOR is kept in sync across every publishable package; PATCH moves independently per package.
To bump versions before a `.tgz` build (or before a real release — see below):

```bash
node scripts/sync-versions.js bump-major-minor 0.2 --apply   # every package, resets PATCH to 0
node scripts/sync-versions.js bump-patch @dappfence/vite --apply   # one package's PATCH only
```

This writes `version` directly into the affected `package.json` file(s) on disk. `bump-major-minor`
also rewrites the cross-package `~X.Y.0` ranges to the new line, since a package from the new
generation must not keep asking for the old one; `bump-patch` leaves them alone, which is the whole
point of pinning the range's floor at `.0`. See `docs/release-setup.md` for the full versioning
policy and the `check` subcommand CI runs before publishing — it fails on a drifted range.

---

## Publishing to npm

Active — see [`docs/release-setup.md`](release-setup.md) for the full setup and release ceremony.
Short version: publishing is automated via `.github/workflows/release.yml`, manually dispatched
against an already-pushed SSH-signed `release-*` tag, gated behind a GitHub Environment approval,
and authenticated to npm via Trusted Publishing (OIDC — no stored token). Manual `npm publish` from
a laptop is a policy violation, not a supported path; see `docs/release-setup.md`'s maintainer
account-hardening section.
