# Release setup

One-time configuration for publishing `@dappfence/*` packages to npm from GitHub Actions, plus the
short-form release ceremony once configured.

This is the first cut of the release process — deliberately scoped to what's needed for a secure,
solid publish path now. It includes CODEOWNERS gating on release-critical paths (Step 1 below —
without it, the tag-signing check is not a real security boundary; see the rest of that step). It
does **not** yet include a daily supply-chain monitor, `npm deprecate` incident tooling, or issue/PR
templates — those are reasonable future additions, not part of this setup.

**A deliberate trade-off worth knowing up front:** the allowed release-signing keys live in a GitHub
Actions repository variable (`RELEASE_SIGNING_KEYS`), not in files in the repo. That means changing
them requires actual repo-admin access to Settings — not just an approved PR — which is a real,
platform-enforced access boundary. The trade-off: a signature is verified against _today's_ variable
value, not against whatever the allowlist looked like when the tag was created. A file committed to
the repo could instead be evaluated at the tag's own commit, immune to being retroactively altered
by a later change — this design gives that property up in exchange for admin-only editability. See
Step 2 below.

## What publishes, and what doesn't

The list of publishable packages is an explicit allowlist in `packages/publish.json` — directory
names under `packages/`, since every publishable package lives there:

```json
["dappfence", "manifest-tools", "astro", "next", "vite"]
```

| Name             | Package                     |
| ---------------- | --------------------------- |
| `dappfence`      | `@dappfence/core`           |
| `manifest-tools` | `@dappfence/manifest-tools` |
| `astro`          | `@dappfence/astro`          |
| `next`           | `@dappfence/next`           |
| `vite`           | `@dappfence/vite`           |

`packages/test-app` is never published — it's an internal dev/e2e harness. `packages/netlify` has no
`package.json` at all (docs only), so it isn't even an npm workspace. Adding a new package under
`packages/` does **not** make it publishable — it has to be added to `packages/publish.json` on
purpose. See "Adding a new package" below.

## Versioning policy

**MAJOR.MINOR is synced across every publishable package; PATCH moves independently per package.**
There is no single "the version of DappFence" beyond the shared MAJOR.MINOR line — a release can
bump just one package's PATCH without touching the others.

```bash
# see current versions
node scripts/sync-versions.js

# bump every publishable package to a new MAJOR.MINOR line (resets PATCH to 0)
node scripts/sync-versions.js bump-major-minor 0.2          # dry run
node scripts/sync-versions.js bump-major-minor 0.2 --apply  # writes package.json files

# bump one package's PATCH only
node scripts/sync-versions.js bump-patch @dappfence/vite          # dry run
node scripts/sync-versions.js bump-patch @dappfence/vite --apply  # writes that one package.json

# verify the MAJOR.MINOR invariant holds (this is what CI runs before publishing)
node scripts/sync-versions.js check
```

Both bump commands refuse to reuse a version already on the npm registry (checked live when
`--apply` is passed) and refuse to move backwards or sideways — npm versions are immutable, so
catching this locally is far cheaper than failing mid-publish.

Cross-package `dependencies` between the publishable packages stay as `"*"` in git — `astro`,
`next`, and `vite` all depend on `@dappfence/core`/`@dappfence/manifest-tools` this way. That's
intentional for the workspace (any locally-linked version satisfies it); it does mean a real npm
consumer of `@dappfence/astro` gets whatever the latest published `@dappfence/core` is at install
time, not a pinned range. Worth tightening once the first few releases have shipped and the
dependency surface has stabilized — not addressed in this first cut.

## Release trigger and versioning are decoupled from each other

A release is triggered by an SSH-signed git tag matching `release-*` (e.g. `release-1`,
`release-2026-04-01`) — the tag string itself carries no version information. Its only jobs are to
be the signed artifact that authorizes "publish whatever `package.json` versions are checked in at
this commit" and to be unique per release event. What actually gets uploaded to npm is decided per
package: for each of the five publishable packages, if its current `package.json` version isn't
already published on npm, it publishes; if it's already live (unchanged since the last release),
it's silently skipped. This is what lets one release carry a single-package PATCH bump without
needing to force-republish everything else.

## One-time setup

### Step 1 — Protect release-critical paths with CODEOWNERS

Do this **before** Step 2. Someone who can edit `release.yml` could point it at a different
variable, disable the signature check outright, or change what `publish` actually uploads; someone
who can edit `packages/publish.json` or `scripts/sync-versions.js` controls what gets published and
under what version. None of that requires touching the signing keys themselves.

`.github/CODEOWNERS` in this repo lists these paths (including itself — otherwise a single PR could
remove a restriction and exploit it in one step) under a maintainer team,
`@coinspect/dappfence-admins`. **This file enforces nothing on its own.** It only takes effect once
you also:

1. Create the team (Org → **Teams** → **New team**) and add the actual maintainers to it. Replace
   `@coinspect/dappfence-admins` in `.github/CODEOWNERS` with the real handle if it differs.
2. Repo → **Settings** → **Branches** → add/edit the protection rule for `main` → **Require a pull
   request before merging** → enable **Require review from Code Owners**.

Without step 2, CODEOWNERS only suggests reviewers in the PR UI — it does not block a merge.

### Step 2 — Enroll SSH signing keys (per maintainer)

The allowed signers live in a single **repository variable**, `RELEASE_SIGNING_KEYS` — not in files
in the repo (see the trade-off callout above). Editing it requires repo-admin access to Settings,
not a PR.

1. Generate a dedicated signing key. You _can_ reuse your everyday GitHub push key instead (same key
   signs and pushes), but stealing it then grants both push and release-signing authority — a
   separate key, ideally hardware-backed, means stealing your laptop doesn't also grant release
   authority:

    ```bash
    ssh-keygen -t ed25519 -f ~/.ssh/dappfence-release
    ```

    Or for a YubiKey (touch-required, non-extractable):

    ```bash
    ssh-keygen -t ed25519-sk -O resident -O verify-required -f ~/.ssh/dappfence-release-sk
    ```

2. Configure git to sign tags with it (do **not** set `commit.gpgsign` — only tags need signing):

    ```bash
    git config --global gpg.format ssh
    git config --global user.signingkey ~/.ssh/dappfence-release.pub
    ```

3. As a repo admin, go to **Settings** → **Secrets and variables** → **Actions** → **Variables** tab
   → edit `RELEASE_SIGNING_KEYS` (create it if it doesn't exist yet), and add one line per
   maintainer in OpenSSH `allowed_signers` format:

    ```
    <handle>@release namespaces="git" ssh-ed25519 AAAAC3Nz... <comment>
    ```

    The `<handle>@release` part is an arbitrary identity string used only in the workflow's log
    output — it doesn't need to match a real GitHub username. The workflow writes this variable's
    value directly to an `allowed_signers` file, so the format above (not just the bare
    `ssh-keygen`-generated public key line) has to be exact.

4. Verify locally before the first release:

    ```bash
    git tag -s release-test -m "signing test"
    echo '<handle>@release namespaces="git" ssh-ed25519 AAAAC3Nz... <comment>' > /tmp/allowed_signers
    git config gpg.ssh.allowedSignersFile /tmp/allowed_signers
    git verify-tag release-test   # must print "Good signature"
    git tag -d release-test
    ```

**Removing a key**: edit the variable and delete that maintainer's line. Takes effect on the next
release. If removal is prompted by suspected key compromise, treat any release signed by that key
that hasn't yet been reviewed as suspect — remember this variable has no history of its own (see the
trade-off callout above), so there's no way to tell after the fact exactly when a line was added or
removed short of GitHub's own audit log (Organization **Settings** → **Audit log**, if your plan
includes it).

### Step 3 — Configure the GitHub Environment (approver gate)

The `publish` job targets the `production-publish` environment. Nothing publishes until this
approves.

1. Repo → **Settings** → **Environments** → **New environment** → name it `production-publish`.
2. Under **Deployment protection rules**: enable **Required reviewers** → add every maintainer
   _except yourself_ (GitHub enforces the approver isn't the same user who started the run).
   Optionally enable a **Wait timer**. Under **Deployment branches and tags**, restrict to
   **Protected tags** matching `release-*`.
3. Save. No secrets needed here — Trusted Publishing uses OIDC.

### Step 4 — Protect the `release-*` tag namespace

Repo → **Settings** → **Rules** → **Rulesets** → **New tag ruleset**:

-   Target: tag pattern `release-*`
-   Enforcement: **Active**
-   Rules: **Restrict creations** (maintainer team only), **Restrict deletions** (disallow for
    everyone — release tags are immutable). Leave GitHub's own **Require signatures** off —
    signatures are verified in the workflow against the on-repo allowlist instead.

### Step 5 — Configure npm Trusted Publisher (per package)

Do this once per package, for all five in the allowlist above.

**Prerequisite:** the package must already exist on npm. For a brand-new package, publish `0.0.0`
once manually with a temporary automation token, then delete that token.

For each package on [npmjs.com](https://www.npmjs.com), as an owner: **Settings** → **Publishing
access** → **Trusted Publisher** → **Add Trusted Publisher** → **GitHub Actions**, and fill in:

-   **Organization or user:** `coinspect`
-   **Repository:** `dappfence`
-   **Workflow filename:** `release.yml`
-   **Environment name:** `production-publish`

Then remove any automation token still attached to the package — `npm publish --provenance` from
this workflow should be the only path to publish.

### Step 6 — Harden maintainer npm accounts

Trusted Publishing closes the CI-token attack surface, but anyone with an active local `npm` session
can still `npm publish` directly, bypassing every gate in `release.yml`. Policy:

-   Don't stay logged in to npm locally. `npm whoami` should fail on your machine at rest.
-   Enable the strongest 2FA available on your npm account, for both auth and writes.
-   Delete any automation token you don't actively need.
-   Never put an `NPM_TOKEN` in any workflow, secret, or `.npmrc` — Trusted Publishing is the only
    supported path from CI.

### Step 7 — Confirm workflow permissions

Repo → **Settings** → **Actions** → **General** → **Workflow permissions**: leave at the default
(**Read repository contents and packages permissions**); leave **Allow GitHub Actions to create and
approve pull requests** off. `release.yml` explicitly requests only `id-token: write` (OIDC) and
`contents: read` where needed — nothing else to grant.

## Release ceremony

**A coordinated release (MAJOR.MINOR bump, or several packages' PATCHes at once):**

```bash
# on main, working tree clean
node scripts/sync-versions.js bump-major-minor 0.2 --apply
git commit -am "chore: release 0.2 line"
git tag -s release-$(date +%Y%m%d) -m "Release 0.2 line"
git push origin main release-$(date +%Y%m%d)
```

**A single-package PATCH release:**

```bash
node scripts/sync-versions.js bump-patch @dappfence/vite --apply
git commit -am "chore(vite): release patch"
git tag -s release-$(date +%Y%m%d) -m "Release @dappfence/vite patch"
git push origin main release-$(date +%Y%m%d)
```

Watch the `release.yml` run. It pauses at the `production-publish` environment — ask a second
maintainer to approve. Once approved, whichever packages actually changed version publish with
`--provenance`; everything already at its current version on npm is skipped, not re-uploaded.

**Dry run first, always, while shaking out the pipeline:** trigger `release.yml` via
`workflow_dispatch` with `dry_run: true` and the tag you just pushed. The full pipeline runs — tag
verify, MAJOR.MINOR check, install, checks, audits, tests, `npm publish --dry-run` — with no upload.

## Adding a new package to the repo

Adding a package to `packages/` does not auto-enroll it in releases. Before it should ship:

-   Add its directory name to `packages/publish.json`.
-   Set its `version` to match the current MAJOR.MINOR line of the other publishable packages.
-   Give it a `files` allow-list covering exactly what consumers need — without one, `npm publish`
    ships everything not gitignored (tests, dotfiles, build caches). Verify with
    `npm pack --dry-run`.
-   Set `publishConfig.access: "public"` (scoped packages default to restricted).
-   Set `repository.directory` to `packages/<dirname>` so provenance attestation points at the right
    subdirectory.
-   Add a `prepublishOnly` script if it needs a build step to produce shippable output (see
    `@dappfence/core`'s `prepublishOnly: "npm run build"` for the pattern) — it fires automatically
    on `npm publish`, and `--foreground-scripts` in the workflow shows its output in the Actions
    log.
-   Configure an npm Trusted Publisher for it (Step 5 above) — the workflow fails with "no matching
    Trusted Publisher" on its first publish otherwise.
-   Make sure it's covered by `npm run check` and the workspace list in the release workflow's "Unit
    tests" step — anything reachable from there runs, and blocks, every release.

## If it goes wrong

-   **Tag signature verification fails** — your key isn't enrolled in the `RELEASE_SIGNING_KEYS`
    repository variable, the line for it doesn't match the exact `allowed_signers` format, or
    `user.signingkey` points at a different key than the one enrolled. Fix locally, delete +
    re-sign + re-push the tag (safe only if nothing has consumed it yet).
-   **`sync-versions.js check` fails** — a publishable package's MAJOR.MINOR doesn't match the rest.
    Run `node scripts/sync-versions.js bump-major-minor <X.Y> --apply` to bring it back in line,
    commit, re-tag.
-   **Publish fails with "no matching Trusted Publisher"** — the workflow filename, environment
    name, org, or repo in the npm Trusted Publisher config doesn't match. Recheck Step 5.
-   **Publish fails with "You cannot publish over the previously published versions"** — that
    package's version isn't actually new. Bump it and re-tag.
-   **Nothing published at all, workflow succeeded** — every publishable package was already at its
    current version on npm; nothing had actually changed. Not an error.

## Not yet built (possible future additions)

-   A scheduled monitor verifying published packages still carry a valid registry signature and
    provenance attestation (drift detection).
-   `npm deprecate`/`dist-tag` incident-response tooling and a runbook for sunsetting a bad release.
-   Pinning intra-workspace `"*"` dependencies to real ranges for real npm consumers.
