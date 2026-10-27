# Changelog

Notable changes to the publishable `@dappfence/*` packages.

This project follows the versioning policy in [docs/release-setup.md](docs/release-setup.md):
MAJOR.MINOR is synced across every publishable package, while PATCH moves independently. A release
therefore does not always move every package, and each entry below names the packages it covers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.4] — 2026-10-27

Covers `@dappfence/core` (`0.1.4`), `@dappfence/astro` (`0.1.4`), `@dappfence/manifest-tools`
(`0.1.3`) and `@dappfence/vite` (`0.1.3`). `@dappfence/next` is unchanged since `0.1.2` and is not
republished.

### Changed

-   **Breaking (`@dappfence/core`): a redirect that the manifest does not declare is now a
    violation.** Redirects were previously waved through — `shouldSkipVerification` treated an
    `opaqueredirect` response as an empty body and skipped it, and a materialized 3xx fell through
    the same way. There was no record of where a request had been sent, so a redirect was an
    unverified hole in the middle of an otherwise verified load. A redirect now resolves against a
    new `redirects` list in the manifest: a declared one is synthesized by the service worker and
    reported as the new non-violating `REDIRECT` status, and an undeclared one is `FILE_UNTRUSTED`
    with `reason: 'REDIRECT_NOT_DECLARED'`, which blocks in protected mode.

    **This needs action before upgrading a site that redirects.** No integration emits
    `manifest.redirects` yet, so the list has to be authored by hand; a site that relied on the old
    skip behaviour and redirects anything — a trailing-slash normalization, a login bounce, a locale
    prefix — will start blocking in protected mode until each redirect is declared. In reporting
    mode it surfaces as a report rather than a block. See
    [docs/redirect-handling.md](docs/redirect-handling.md) for the schema and the reasoning.

-   `@dappfence/core`: `resolveManifestKey` keys off `response.url` only when `response.redirected`
    is set, rather than whenever the response carried a URL. The old form let any response that
    reported a URL silently re-point the manifest lookup away from the requested path.
-   `@dappfence/core`: `/sw-api/status` reports more than it used to. Verification results
    previously held `MATCH` records only, with everything else written to a separate security-event
    log; all non-`SKIPPED` outcomes now land in verification results, so failures appear alongside
    passes. The payload's shape is unchanged, but each record is now a fixed projection — `status`,
    `timestamp`, `fileKey`, `reason`, `expectedHashes`, `actualHash` — and no longer carries
    `userAgent` or `origin`.
-   `@dappfence/core`: the service worker's IndexedDB layout is now one object store per concern
    (`manifests`, `activeBlocks`, `settings`, `verificationResults`) instead of a single `data`
    store, and the dead security-events store is gone. This is internal to the bundle — no exported
    API changes — but see the upgrade note under Fixed.

### Added

-   **`@dappfence/core`: `manifest.redirects`.** Each entry is `{ from, to, status? }`, where
    `status` defaults to `302`. The list is validated when the manifest is normalized, and a bad
    entry is dropped with a warning rather than failing the load: entries of the wrong shape, a `to`
    using a `javascript:` or `data:` scheme, a self-loop, a duplicate `from`, or a non-integer
    `status`.
-   `@dappfence/core`: a `REDIRECT` verification status and a `REDIRECT_NOT_DECLARED` file-untrusted
    reason, both on the `./constants` entry point. The additions are backwards compatible — nothing
    was removed or renamed.
-   `@dappfence/core`: the warning page explains the specific failure instead of always reporting
    modified content. Each status and reason maps to its own title and field labels — a hash
    mismatch shows expected against actual, a signature mismatch shows pinned against recovered
    signer, and a reason with neither omits the rows instead of printing `N/A`. A manifest-level
    failure also gets a distinct page summary, since "content has been modified" is misleading when
    the trust anchor is what failed.
-   `@dappfence/core`: `settingsStore.getSessionId()`, a per-install UUID generated once and
    intended for tagging outgoing telemetry.
-   `@dappfence/manifest-tools`: `generateManifest` accepts a `scriptHash` option for the DappFence
    script's own pre-computed hash, kept separate from `extraHashes` so the two are reported
    independently.

### Fixed

-   **`@dappfence/core`: upgrading from `0.1.x` no longer breaks the service worker's storage.** The
    storage layer moved from a single catch-all `data` object store to one store per concern
    (`manifests`, `activeBlocks`, `settings`, `verificationResults`) but kept both the database name
    (`AppSecurity`) and its schema version at `1`. IndexedDB decides whether to run migrations
    purely from that version, so a browser already holding the `0.1.x` database opened it, skipped
    `onupgradeneeded`, and never created the new stores — the first transaction naming one of them
    threw `NotFoundError`, and because nothing wraps that call, every storage operation in the
    service worker failed. Fresh installs were unaffected, which is why it survived the test suite.
    The schema version is now `2`, so the existing upgrade handler runs and creates the stores.

    Data written under the old layout is not migrated — the stale `data` store is left in place,
    unused — so an upgraded client starts from the same state as a fresh install: the trusted
    manifest is re-fetched and re-verified, a new API token is issued, and recorded verification
    results are gone. The signer identity is unaffected, since it comes from the service worker's
    build-time configuration rather than from storage. One consequence is worth stating plainly: an
    active site-wide block does not survive the upgrade, so a client sitting on the warning page
    returns to the site until the next violation re-triggers the block.

-   **`DAPPFENCE_SECRET_KEY` in a `.env` file is now actually read** (#73). Neither Astro nor Vite
    copies `.env` into `process.env` — they load the env files themselves and expose the result
    through `import.meta.env` / `astro:env`, long after `astro.config.mjs` or `vite.config.js` has
    been evaluated. Both plugins resolved the key from `process.env` while the config file was being
    constructed, so a key stored exactly where the README said to put it was invisible and every
    local build failed with `secretKey is required`. Both now load the env files the same way their
    host does, at a point in the lifecycle where the project root is known. The documented
    precedence is unchanged: an explicit `secretKey` option beats a real environment variable, which
    beats a `.env` entry.

    Two consequences worth noting. `@dappfence/astro` now declares `vite` as a peer dependency, as
    `@dappfence/vite` already did. And because the `astro:config:setup` hook is not told the build's
    `--mode`, the integration assumes `production` for `astro build` and `development` for
    `astro dev`; a mode-specific file such as `.env.staging` still needs the key passed explicitly.

-   `@dappfence/astro`: the signer identity is now derived inside the build path rather than when
    the integration object is constructed, so a malformed key no longer fails `astro dev` and
    `astro check` — commands that never use the key.
-   `@dappfence/manifest-tools`: the DappFence script is no longer counted as a pre-computed SSR
    route hash. It is copied into the output directory and excluded from the walk, so its hash
    arrives pre-computed like an SSR route's — folding it into the same tally made every static
    build report one SSR route hash it never had. It is now passed as `scriptHash` and logged on its
    own line.

### Security

-   **A hardcoded `secretKey` no longer overrides CI's key silently.** An explicit option outranks
    `DAPPFENCE_SECRET_KEY` by design, but nothing said so at build time — so a development key
    committed to `astro.config.mjs` or `vite.config.js` would also win in CI, and the production
    manifest was signed with a key anyone who can read the repository knows. That key's address is
    what the deployed service worker trusts, so the protection was defeated for exactly the people
    the threat model excludes.

    The precedence is unchanged — it is the documented contract, and flipping it would break builds
    that deliberately override the environment. Instead both plugins now warn when an explicit
    option and a `DAPPFENCE_SECRET_KEY` (environment or `.env`) are both set and differ, naming the
    `process.env.DAPPFENCE_SECRET_KEY ?? DEV_KEY` form that lets the environment take over. The
    comparison ignores an `0x` prefix and case, since `signManifest` accepts either spelling and an
    equivalent pair is not a conflict.

### Documentation

-   The `@dappfence/astro` README no longer presents a hardcoded `secretKey` as the key-resolution
    example. It now recommends passing no option at all, carries an explicit warning about the
    precedence, and shows the `??` form for projects that genuinely want a local fallback. The same
    warning was added to the `@dappfence/vite` README.
-   The `.env` caveat above is documented in the `@dappfence/astro` and `@dappfence/vite` READMEs,
    including the `loadEnv` snippet needed for non-default `--mode` builds.
-   Corrected the key-resolution example in the `@dappfence/astro` README (and the matching comment
    in the Astro example app), which claimed an explicit `secretKey` option was "overridden by
    `DAPPFENCE_SECRET_KEY` if set" — the opposite of the documented and implemented precedence.
-   `@dappfence/manifest-tools`: noted that its CLI, unlike the bundler plugins, does not read
    `.env` on its own and needs `node --env-file` or an exported variable.
-   [docs/redirect-handling.md](docs/redirect-handling.md) covers the redirect model: what the
    service worker can and cannot observe about a redirect, why an undeclared one is treated as a
    violation, and how to author `manifest.redirects`.
-   The `@dappfence/core` README's module map reflects the split storage layout.

## [0.1.3] — 2026-10-26

Covers `@dappfence/core` and `@dappfence/astro`. `@dappfence/manifest-tools`, `@dappfence/next` and
`@dappfence/vite` are unchanged since `0.1.2` and are not republished.

### Changed

-   **Breaking (`@dappfence/core`): untrusted statuses are unified behind two umbrella statuses.**
    The separate manifest-layer and asset-layer violation statuses collapse into
    `MANIFEST_UNTRUSTED` and `FILE_UNTRUSTED`, each carrying the specific cause on a `reason`
    sub-field. Fetch-failure reasons were renamed in the same pass so the mechanism is
    self-describing. Code that switches on the old status constants needs updating to read `reason`.
-   `@dappfence/astro`: the integration now runs only for `astro build`, instead of also running
    during `astro dev` and other commands where its output is not used.

### Added

-   **The published bundle is reproducible, and anyone can verify it.** `npm run verify-published`
    reads npm's provenance attestation to learn which commit was published, rebuilds from that
    commit, and compares sha512 digests against the tarball the registry served. It requires no
    access to the repository or to npm. Checking `@dappfence/core` needs linux x64, since the
    `@rollup/*` and `@esbuild/*` native binaries decide the bundle's bytes; the script detects other
    platforms and prints a `docker run` line that works from any host.
-   **Releases are authorized over the published bytes, not just the commit.**
    `npm run release-manifest` builds and packs every publishable package inside the digest-pinned
    build image and emits a sha256 of every file in every tarball. The maintainer signs that
    manifest into the release tag, and CI rebuilds and refuses to publish anything whose hash
    differs — so a release requires two independent machines to agree on the bytes.
-   `scripts/check-release-config.js` fails a release when the repository's rulesets, environment
    protection, or CODEOWNERS have drifted from `.github/release-policy.json`.
-   `@dappfence/core`: the `reportOnFetch`, `reportOnInstall`, `reportOnClientRequest`,
    `reportOnSync` and `reportOnPageLoad` entry points on `securityProcessor`, with the message and
    lifecycle plumbing that drives them. **These are stubs that only log** — the queue, dedup and
    remote send land in a later release.
-   `tsc --checkJs` type-checking is now part of `npm run check`.

### Fixed

-   `@dappfence/core`: sub-resource manifest lookups are keyed by `response.url`, so a followed
    redirect no longer misses its manifest entry.
-   `@dappfence/core`: a pinned client now escalates its manifest search when a sub-resource fails
    verification, rather than falling through.
-   `@dappfence/core`: manifest-untrusted short-circuits correctly during escalation, and an `ERROR`
    fallback no longer masks the real status.
-   `@dappfence/core`: the newline Netlify injects alongside the CDP block is stripped, so the
    injected content hashes as intended.
-   `npm run verify-published` had two paths on which it could report a pass having checked nothing:
    an attestation naming no commit, and one naming no subject digest. Both are now hard failures.
-   The release pipeline passes the Node pin to the `publish` job explicitly, since that job has no
    checkout and so cannot read `.nvmrc`, and pins the manifest container to CI's architecture.

### Removed

-   `@dappfence/core`: the build timestamp and `process.versions.node` are no longer substituted
    into `__DAPPFENCE_BUILD_INFO__`. Reading the build machine into the bundle is what made builds
    unreproducible; `version` and `commit` remain, both derived from the tagged source. Provenance
    records the real build time and environment where it cannot be edited afterwards.

### Security

-   Release-critical paths are gated by CODEOWNERS, the `release-*` tag namespace is immutable once
    pushed, and the `publish` job holds the npm credential while running no repository code and
    performing no checkout. See [docs/release-setup.md](docs/release-setup.md) for the full model
    and its boundaries.
-   PR workflow runners and actions are pinned.

### Known limitation

-   Versions before `0.1.3` cannot be reproduced. `0.1.2` was published while the Node version was
    still baked into the bundle, so rebuilding it on any other Node produces different bytes. That
    is expected, not tampering.

## [0.1.2] — 2026-10-08

Initial tracked release of `@dappfence/core`, `@dappfence/manifest-tools`, `@dappfence/astro`,
`@dappfence/next` and `@dappfence/vite`. Released before this changelog was introduced; see the git
history for the changes it contained.
