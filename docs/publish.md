# Publishing and Distribution

## Packages

| Package                     | Directory                 |
| --------------------------- | ------------------------- |
| `@dappfence/core`           | `packages/dappfence`      |
| `@dappfence/manifest-tools` | `packages/manifest-tools` |
| `@dappfence/astro`          | `packages/astro`          |
| `@dappfence/next`           | `packages/next`           |

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
        "@dappfence/astro": "file:vendor/dappfence-astro-0.1.0.tgz"
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

All publishable packages are always kept at the same version. To bump versions before a release:

```bash
npm run sync-versions -- 0.2.0
```

This updates `version` in every non-private `package.json` and pins the `"*"` workspace deps to the
exact version. It modifies files on disk — do not commit the result when distributing via `.tgz`.
For `.tgz` distribution the version bump only matters so the filenames and `version` fields in the
packed manifests are correct.

---

## Future: publishing to npm

Not yet active. When ready, publishing will be automated via GitHub Actions (workflow to be added at
`.github/workflows/publish.yml`). The tag is the source of truth for the published version
`sync-versions` will run inside the ephemeral CI workspace so no version-bump commit is needed in
the repo.

See the **Version management** section above for the `sync-versions` script that both workflows
share.

### Manual publish (when npm publishing is active)

```bash
npm test
npm run sync-versions -- 0.2.0
npm run build:prod -w @dappfence/core
npm login
npm publish -w @dappfence/core
npm publish -w @dappfence/manifest-tools
npm publish -w @dappfence/astro
npm publish -w @dappfence/next
```

Publish in that order: `@dappfence/core` and `@dappfence/manifest-tools` have no inter-dependencies;
`@dappfence/astro` and `@dappfence/next` depend on both and must go last.
