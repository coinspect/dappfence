# Dependency Upgrade Strategy

DappFence pins exact versions for all dependencies (no `^` or `~`) to minimize supply chain attack
surface. Upgrades are security-driven: we do not chase the latest version. An upgrade is warranted
only when there is a concrete security reason.

## When to upgrade

-   `npm audit` flags a vulnerability in a current dependency
-   A CVE is published against a package we use
-   [socket.dev](https://socket.dev) signals suspicious behavior in a new release

Periodically (e.g., monthly) run `npm audit` to catch newly disclosed CVEs against current versions.

## Workflow

One package per commit. Never batch multiple upgrades.

1. **Inventory**

    ```bash
    npm audit          # find CVEs — this is the trigger
    npx npm-check-updates            # see what's outdated (informational only)
    ```

2. **Review before upgrading** (for each package)

    - Read the changelog / GitHub releases between the current and target version
    - Inspect the actual code diff:
        ```bash
        npm diff <pkg>@<old-version> <pkg>@<new-version>
        ```
    - Check [socket.dev](https://socket.dev) for the package it flags new installation scripts, new
      network access, obfuscated code, and maintainer changes

3. **Apply and test**

    ```bash
    npx npm-check-updates <package-name>     # updates package.json to exact new version
    npm install            # updates package-lock.json
    npm test               # full suite including e2e
    ```

4. **Commit**
    ```bash
    git commit -m "chore: bump <pkg> <old-version> -> <new-version>"
    ```
    Include the security reason in the commit body if applicable.

## Keeping package-lock.json trustworthy

`package-lock.json` is a security artifact, not just a convenience file. It records the exact
resolved version and a sha512 `integrity` hash for every package in the tree. Npm verifies that hash
on every installation if a package is swapped or tampered with between releases, the installation
fails.

**Normal installation**

Always use `npm ci` instead of `npm install` in CI and when you just want a clean node_modules:

```bash
npm ci   # installs exactly what package-lock.json says, never modifies it
```

`npm install` re-resolves the tree and rewrites the lock file as a side effect, fine when you intend
to upgrade, but a silent footgun otherwise.

**Regenerating the lock file without touching node_modules**

After editing `package.json` directly (e.g., changing a version), regenerate the lock file without a
full installation:

```bash
npm install --package-lock-only
```

This re-resolves the tree and rewrites `package-lock.json` without touching `node_modules`. Useful
when you want to review the lock diff before committing.

**Direct edits to package-lock.json**

Avoid editing the file by hand. The only cases where it makes sense:

-   Resolving a merge conflict: edit minimally, then run `npm install --package-lock-only` to
    re-resolve and restore correct hashes
-   Overriding a transitive dependency that has a CVE and has not been patched upstream: use
    `overrides` in `package.json` instead when possible, that keeps the intent in a source and lets
    npm recompute correct hashes automatically

**Never delete or blank out the `integrity` field.** Each entry looks like:

```json
"integrity": "sha512-abc123…"
```

This is the sha512 hash of the package tarball. Npm checks it on every installation. If it is
missing, npm skips verification silently, meaning a tampered package could be installed without any
signal. Losing integrity hashes breaks the supply chain guarantee that exact-version pinning is
meant to provide.

**Automated integrity check**

`scripts/check-lock-integrity.js` audits `package-lock.json` for supply chain gaps that are easy to
miss by eye:

1. `lockfileVersion` must be ≥ 2 — v1 lacks per-package integrity hashes in the `packages` map
2. Every registry package must have an `integrity` field — missing entries silently bypass tamper
   detection (see below)
3. Every `integrity` hash must use `sha512`, not the deprecated `sha1`
4. Every registry package must resolve from `registry.npmjs.org` — a non-official origin is a
   lockfile poisoning signal

Run it after any change to `package-lock.json`:

```bash
node scripts/check-lock-integrity.js
```

Exit code is `0` on a clean lock file, `1` with a list of failures. Add this to CI alongside
`npm audit` so regressions are caught before merge.

**Why entries go missing**

Under certain conditions (usually bugs), npm can silently drop `integrity` (and `resolved`) fields
from lock file entries. In those cases npm does not warn you. We added the script to avoid
accidentally committing a lock file with missing integrity hashes even if you are not aware of the
bugs.

---

## Rationale

Reviewing one package at a time with a changelog + diff + socket.dev gate makes it possible to catch
behavioral changes before they land. Not upgrading without a reason keeps the window of exposure
minimal — every upgrade is a potential vector.
