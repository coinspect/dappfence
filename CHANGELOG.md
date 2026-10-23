# Changelog

Notable changes to the publishable `@dappfence/*` packages.

This project follows the versioning policy in [docs/release-setup.md](docs/release-setup.md):
MAJOR.MINOR is synced across every publishable package, while PATCH moves independently. A release
therefore does not always move every package, and each entry below names the packages it covers.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.3] — 2026-10-23

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
