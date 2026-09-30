# Release setup

> ⚠️ **Alpha phase — releases go under the `alpha` dist-tag by default.** Cut tags as
> `v0.X.Y-alpha.N` (or `-rc.N`, `-beta.N`). The workflow parses the suffix and publishes with
> `--tag <suffix>`, so `latest` is not affected. Only when you tag a plain `v0.X.Y` (no suffix) will
> consumers get it via `npm install @dappfence/core`. Do not tag a plain version until we declare
> stability.

One-time configuration for publishing `@dappfence/*` packages to npm from GitHub Actions, plus the
short-form release ceremony once configured.

## Overview

```
maintainer                     github                       npm
    │                             │                          │
    │ 1. git tag -s v0.2.0        │                          │
    │ 2. git push origin v0.2.0   │                          │
    │────────────────────────────▶│                          │
    │                             │ 3. release.yml:          │
    │                             │    verify SSH signature  │
    │                             │    against on-repo       │
    │                             │    allowlist             │
    │                             │                          │
    │ 4. approver clicks approve  │                          │
    │◀────────────────────────────│                          │
    │────────────────────────────▶│                          │
    │                             │ 5. build + test          │
    │                             │ 6. npm publish           │
    │                             │    --provenance          │
    │                             │─────────────────────────▶│
    │                             │    (OIDC handshake,      │
    │                             │     no token in secrets) │
```

Three trust anchors: (a) the SSH signing key that signs the release tag, (b) the GitHub Environment
"required reviewers" list, (c) npm's Trusted Publisher configuration pointing at this repo's
`release.yml`. Compromise anyone and the release still fails.

## Trust chains

Every step in the release depends on trusting something that came before. Making the chains explicit
makes it obvious where a compromise breaks the model — and where it doesn't.

### Trust anchors

-   **Signing keys in `.github/release-keys/*.pub`** — trusted by the workflow to authorize tags.
    Changes to this directory must land through a normal reviewed PR to `main`. The workflow reads
    the allowlist _at the tag commit_, so an attacker who lands a rogue key today cannot
    retroactively make an earlier tag verify.
-   **GitHub Environment `production-publish` reviewer list** — trusted to block the publish step
    until a second maintainer approves. Managed in repo settings by admins.
-   **npm Trusted Publisher config on each package** — trusted to accept OIDC tokens issued by
    GitHub for `coinspect/dappfence @ .github/workflows/release.yml @ production-publish`. Managed
    on npmjs.com by whoever owns the `@dappfence` scope.
-   **GitHub as a platform** — trusted to issue OIDC tokens honestly, enforce environment gates, and
    run the workflow as written. Not something you can meaningfully mitigate; treat GitHub
    compromise as an existential-scope event.

### Roles

-   **Releaser** — signs the tag, initiates the workflow. Holds an enrolled SSH key. Their key
    proves _who authorized this tag object_.
-   **Approver** — a different GitHub user, listed in the environment's Required Reviewers. Clicks
    approve after reviewing the diff since the last tag and confirming build/test output. Their
    click proves _a second human agrees to publish these specific bytes_.
-   **Repo admin** — configures the environment, the tag ruleset, and workflow permissions. Not
    required at release time, but their configuration is what makes the approver gate binding.
-   **npm scope owner** — maintains the Trusted Publisher config and package ownership. Not required
    at release time, but their configuration is what limits publish authority to this workflow.
-   **Monitor watcher** — reads the daily monitor GitHub issues. Any ALARM is triaged as a potential
    incident. Informal role; anyone with issue-read access can fill it.

### Chain 1 — What authorizes the tag

```
Releaser's YubiKey / SSH signing key
    │  signs
    ▼
git tag object v0.2.0  (SHA-1 tag pointing at commit C)
    │  verified against
    ▼
allowed_signers built at runtime from .github/release-keys/*.pub  at commit C
    │  which was only writable via
    ▼
signed PRs merged to main by repo admins
```

If the releaser's key is stolen, the attacker can forge tags — but only pointing at commits that
already exist. To point at a malicious commit they must also land it on `main`, which requires code
review. To bypass review they'd need to compromise a repo admin.

### Chain 2 — What authorizes the publish

```
Tag verification passes on the runner
    │
    ▼
publish job requests OIDC token from GitHub Actions
    │  scoped to (repo=coinspect/dappfence, workflow=release.yml, env=production-publish)
    ▼
job pauses at production-publish environment
    │  requires approval from a Required Reviewer  ≠  the workflow initiator
    ▼
approver clicks approve
    │
    ▼
runner receives OIDC token, presents to npm
    │  npm compares to its Trusted Publisher config for the package
    ▼
npm issues short-lived publish credential, tarball is published with --provenance
```

If the approver's GitHub account is compromised, they can approve — but the _releaser_ had to sign a
tag first (Chain 1). If the releaser's account is compromised, they can push a tag — but the
approver still has to click approve. Neither compromise alone completes a publish. This is the
"two-person control" the design is buying.

### Chain 3 — What a consumer trusts on `npm install`

```
consumer runs `npm install @dappfence/core`
    │
    ▼
npm registry serves tarball + integrity hash + registry signature + provenance attestation
    │  npm client verifies:
    ▼
      · tarball bytes → sha512 → matches integrity
      · registry ECDSA signature → matches npm's public key
      · provenance attestation (Sigstore) → binds tarball to
        (github.com/coinspect/dappfence, .github/workflows/release.yml, commit SHA, run ID)
    │  consumer can additionally verify:
    ▼
`npm audit signatures`  (registry sig on every dep in the tree)
Sigstore Rekor public log  (independent record of the attestation)
```

The daily monitor (`monitor.yml`) does the first three checks continuously so drift between "what we
published" and "what npm serves" is caught within 24 hours.

### Where the chains _don't_ protect you

-   **GitHub itself compromised.** If GitHub's OIDC issuer or the Actions runner is compromised at
    the platform level, the trusted publisher trust is meaningless. No practical mitigation exists
    inside the release workflow.
-   **A malicious commit reaches `main` and is tagged legitimately.** Both the releaser and the
    approver review the diff — but if the malicious change is small and obfuscated, they may miss
    it. This is a code review problem, not a release-workflow problem; the release workflow
    faithfully publishes whatever `main` contains at the tag.
-   **The npm scope is compromised at the account level.** If someone steals control of the
    `@dappfence` scope, they can disable Trusted Publishing and publish arbitrary bytes with a new
    token. The monitor catches this by detecting a publish that did not come from this workflow
    (missing/wrong provenance attestation). Response is _yank via advisory + rotate scope
    ownership_, not "prevent."
-   **A rogue release key added and used in one PR.** In principle an attacker who compromises a
    repo admin could merge a PR that adds their key and then immediately sign a tag. Mitigation:
    branch protection on `main` requiring at least one reviewer, plus signed-commit requirement on
    changes to `.github/release-keys/` (enforce via CODEOWNERS + required review).

## Step 1 — Enroll SSH signing keys (per maintainer)

Each maintainer who may sign a release tag adds their SSH public key to
`.github/release-keys/<handle>.pub`. See
[`.github/release-keys/README.md`](../.github/release-keys/README.md) for key generation and PR
flow.

Verify the setup works locally before the first release:

```bash
git tag -s v0.0.0-test -m "signing test"
git config gpg.format ssh
git config gpg.ssh.allowedSignersFile .github/release-keys/<your-handle>.pub
# (temporary — the workflow builds the same file at runtime)
git verify-tag v0.0.0-test
git tag -d v0.0.0-test
```

`git verify-tag` must print `Good signature` for your handle. If it fails, your `user.signingkey`
does not match the key you enrolled.

## Step 2 — Configure the GitHub Environment (approver gate)

The `publish` job in `release.yml` targets the `production-publish` environment. Nothing publishes
until the environment gate approves.

1. Repo → **Settings** → **Environments** → **New environment** → name `production-publish`.
2. Under **Deployment protection rules**:
    - Enable **Required reviewers** → add every maintainer _except yourself_. GitHub enforces that
      the approver cannot be the same GitHub user that started the workflow run.
    - Enable **Wait timer** (optional, e.g. 5 minutes) — gives the approver time to notice.
    - Under **Deployment branches and tags** → restrict to **Protected tags** matching `v*`.
3. Save.

The environment does not need any secrets — Trusted Publishing uses OIDC.

## Step 3 — Protect the `v*` tag namespace

Repo → **Settings** → **Rules** → **Rulesets** → **New tag ruleset**:

-   Target: tag pattern `v*`
-   Enforcement: **Active**
-   Rules:
    -   **Restrict creations** — allow only the maintainer team
    -   **Restrict deletions** — disallow for everyone (release tags are immutable)
    -   **Require signatures** — off (we verify signatures in the workflow against the on-repo
        allowlist, not GitHub's general signed-commit machinery)

## Step 4 — Configure npm Trusted Publisher (per package)

Do this once per package: `@dappfence/core`, `@dappfence/manifest-tools`, `@dappfence/astro`,
`@dappfence/next`.

**Prerequisite:** the package must exist on npm. For a brand-new package, publish version `0.0.0`
once manually with an automation token, then delete the token, then set up Trusted Publishing.

For each package:

1. Log in on [npmjs.com](https://www.npmjs.com) as an owner of the package.
2. Go to the package page → **Settings** → **Publishing access**.
3. Under **Trusted Publisher** → **Add Trusted Publisher** → **GitHub Actions**.
4. Fill in:
    - **Organization or user:** `coinspect`
    - **Repository:** `dappfence`
    - **Workflow filename:** `release.yml`
    - **Environment name:** `production-publish`
5. Save.

Verify no long-lived tokens are configured: package page → **Settings** → **Access tokens** → remove
any automation token still tied to the package. `npm publish --provenance` from this repo's
`release.yml` is now the only path to publish.

## Step 4b — Harden every maintainer's npm account

Trusted Publishing closes the CI-token attack surface, but any maintainer with an active `npm`
session on their laptop can still run `npm publish` and bypass every gate in `release.yml` (tag sig,
approver, checks, tests, provenance). This is a fundamental limit of npm's model as of writing:
publish authority follows the account, and the account is separate from the CI identity.

**Policy for every maintainer:**

1. **You must NOT be logged in to npm on your machine during normal operation.** Run `npm logout`
   after any incident-response activity. `npm whoami` should exit non-zero on your machine at rest.
   This is the single most impactful mitigation — an attacker who compromises your laptop cannot
   publish without first getting through 2FA on a fresh login.
2. **Enable 2FA at the strongest level** on npm.com → **Account settings** → **Two-factor
   authentication** → require 2FA for both authentication _and_ writes (publish, deprecate,
   dist-tag). Even if you slip and stay logged in, publish still prompts for an OTP.
3. **Delete every automation token owned by the account.** npm.com → **Access tokens** → revoke
   anything not actively required. Automation tokens bypass 2FA and are the most common bypass path.
4. **Never use `NPM_TOKEN` in CI.** Trusted Publishing is the only supported path. If you find a
   token in any workflow, secret, or `.npmrc` — delete it and rotate.
5. **Do not publish from a laptop as policy.** Only `release.yml` publishes real releases. The only
   legitimate local invocations are `scripts/deprecate.js` calls during an active incident (which
   cannot go through Trusted Publishing). Every other local publish is a policy violation and — if
   noticed — should trigger key rotation and a rogue-publish audit.

### Login-for-incident workflow

Both npm and `gh` sessions are dangerous when idle. Same discipline for both — log in only when
needed, log out immediately after:

```bash
# npm — needed for deprecate / dist-tag / repoint-latest
npm login                                 # interactive; prompts for OTP
node scripts/deprecate.js <subcommand>    # do the incident work
npm logout
npm whoami                                # must fail (Not logged in)

# gh — needed to cancel an in-flight release run, if any
gh auth login                             # interactive; browser OAuth
gh run cancel <run-id>
gh auth logout
gh auth status                            # must show 'not logged in'
```

For the CLI-averse or when you're on a fresh machine: **do it in the browser instead**. Both npm.com
(deprecate at package page → Settings → deprecate a version) and github.com (Actions → release
workflow → Cancel workflow) let you perform the same operations from a browser session, which leaves
no local credential on disk. Browser is the safer default.

Treat the logged-in state as short-lived, minutes not hours. If you have to leave your desk while
either session is live, log out first.

Same 2FA policy on both: enable strongest 2FA on npm.com and github.com. Prefer hardware-key
(YubiKey) as the second factor. TOTP is acceptable but weaker.

The residual risk (compromised laptop _during_ an incident with an active session + 2FA device
already touched) is caught retrospectively by the monitor: a laptop publish produces no Sigstore
provenance attestation, so `monitor.yml` files an ALARM within 24 hours. Response then is: rotate
credentials, deprecate whatever got published.

If npm ships a "trusted-publisher-only" mode for a package (equivalent to PyPI's), enable it
immediately — that would remove the laptop-publish path entirely and make this section obsolete.

## Step 5 — Confirm workflow permissions

Repo → **Settings** → **Actions** → **General**:

-   **Workflow permissions** → **Read repository contents and packages permissions** (default)
-   **Allow GitHub Actions to create and approve pull requests** → off

`release.yml` explicitly requests `id-token: write` (for OIDC) and `contents: read` on the publish
job — no other permissions needed.

## Step 6 — Enable the supply-chain monitor

The monitor workflow (`.github/workflows/monitor.yml`) runs daily at 13:00 UTC. It checks that the
latest published version of `@dappfence/core` has:

-   a registry signature (npm ECDSA)
-   a Sigstore provenance attestation
-   a tarball whose sha512 matches the packument integrity

Failures are filed as GitHub issues with the `monitor-alert` label. No configuration required — it
uses `secrets.GITHUB_TOKEN` (auto-provided) and runs on schedule as soon as it lands on `main`.

Trigger a run manually to smoke-test after landing this PR:

```bash
gh workflow run monitor.yml
gh run watch
```

Before the first published version exists, the monitor emits an INFO observation ("package not yet
published") and exits clean.

## Version syncing

All `@dappfence/*` packages ship at the same version. `scripts/sync-versions.js` is the mechanism.
The version bump is **committed to git** and the tag points at that commit — the workflow does _not_
silently rewrite versions at publish time. This keeps `main` honest: whatever version you see in
`packages/*/package.json` on a given commit is exactly what was published for that tag.

Two modes:

```bash
# bump every package to a new version (writes package.json in place; leave * deps alone)
node scripts/sync-versions.js 0.2.0            # dry run — shows the diff
node scripts/sync-versions.js 0.2.0 --apply    # applies + runs 3 preconditions

# CI-only: pin intra-workspace * deps to each package's current version
# (rewrites in the ephemeral runner workspace; not committed)
node scripts/sync-versions.js --pin-only --apply
```

The bump preconditions (all hard-fail, no `--force`):

1. **Consistency** — every publishable package must currently be at the same version. Catches
   half-synced trees from a prior failed release.
2. **Local monotonicity** — target must be strictly greater than every current version. Catches
   downgrades and typos.
3. **Registry monotonicity** — target must not already exist on npm. Immutability means republish is
   impossible; failing here is much faster than failing at publish time.

Developer flow for a release:

```bash
# on main, working tree clean
node scripts/sync-versions.js 0.2.0 --apply
git commit -am "chore: release 0.2.0"
git tag -s v0.2.0 -m "Release 0.2.0"
git push origin main v0.2.0
```

The `verify` job in `release.yml` re-checks every `packages/*/package.json` at the tagged commit and
refuses to publish if any version does not match the tag. If it fails: run
`sync-versions.js <version> --apply` again, commit, delete + re-sign the tag, re-push.

Intra-workspace `*` deps stay `*` in git (per convention — never commit a pin). The workflow
rewrites them in the runner workspace via `--pin-only --apply` immediately before publish. This is
the only step of the release that mutates state ephemerally.

## Iterating on the release pipeline itself (first-time setup)

Published npm versions are **immutable** — you cannot republish `@dappfence/core@0.2.0` with
different bytes. Ever. During initial shakedown of this workflow, you will make small mistakes; plan
for them:

1. **Dry-run first.** Trigger `release.yml` via `workflow_dispatch` with `dry_run=true`. The full
   pipeline runs — tag verify, parity check, install, checks, audits, tests, sync-versions,
   `npm publish --dry-run`. No upload. Free to iterate.
2. **Then prerelease.** Tag `v0.2.0-rc.1`, `-rc.2`, … each is a real publish but goes under the `rc`
   dist-tag (not `latest`), so `npm install @dappfence/core` still returns the last stable. Add
   `--tag rc` to the publish command for prerelease versions if you want strict separation. Each
   `-rc.N` still burns a version number — that's normal.
3. **Only then the real one.** Cut `v0.2.0` once dry-runs and rcs are clean.
4. **If a real publish is broken:** `npm deprecate @dappfence/<pkg>@<version> "reason"` and cut a
   patch (`0.2.1`). `npm unpublish` is not a hotfix — it's limited to 72h + zero-download windows
   and creates a 24h re-registration hole.

## Adding a new package to the repo

The release workflow publishes **every non-private workspace under `packages/*`**. Adding a new
package therefore auto-enrolls it into every future release — there is no separate opt-in step. That
is a feature (workflow stays generic) and a risk (a package that is not ready to ship will still
ship). Before merging a new package to `main`, verify each of the following:

-   **`private` flag** — set `"private": true` in `package.json` if the package should never be
    published (test fixtures, internal tools). This is the only opt-out.
-   **`files` allow-list** — set a `files` array covering exactly what consumers need at runtime.
    Without it, npm publishes _everything_ not in `.gitignore` (including tests, secrets, editor
    dotfiles, build caches). Verify with `npm pack --dry-run` inside the package directory before
    merging.
-   **`publishConfig.access`** — for a scoped package (`@dappfence/*`), set to `"public"`. Scoped
    packages default to restricted, which the workflow overrides via `--access public` but the
    package-level field makes intent explicit.
-   **`repository.directory`** — set to `packages/<dirname>` so npm's provenance attestation points
    at the exact source subdirectory.
-   **`prepublishOnly`** — if the package needs a build step to produce shippable artifacts (e.g.
    Vite build → `dist/`), add a `prepublishOnly` script. It fires automatically during
    `npm publish` and its output shows in the Actions log because the workflow passes
    `--foreground-scripts`. Do not rely on the root `build:prod` script — the workflow does not call
    it explicitly anymore.
-   **Cross-package `dependencies`** — use `"*"` for workspace deps. `scripts/sync-versions.js`
    replaces them with the pinned version at publish time via `--pin-deps`.
-   **npm Trusted Publisher** — configure one for the new package as described in Step 4 below. The
    workflow will fail with "no matching Trusted Publisher" on first publish otherwise.
-   **Test coverage** — the workflow runs `npm test` before publishing. Anything reachable from that
    command runs on every release; keep it stable.

The `Audit dependencies` steps run against the whole workspace, so a new package with a vulnerable
dep will block every release, not just its own. Choose deps accordingly.

## Release ceremony (short form)

Once all of the above is configured:

```bash
# on main, working tree clean, all workflows green
git pull
git tag -s v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

Watch the `release.yml` run. When it pauses at the `production-publish` environment, ask a second
maintainer to approve. Once approved, `npm publish --provenance` runs and the packages appear on npm
within ~30 seconds. The next daily monitor run confirms registry signatures + attestation.

## Emergency response

There is no "big red button" that stops publishing on npm — the platform offers no scope-wide
freeze, no session invalidation, no read-only toggle. The best we can do in an incident is:

1. **Cancel any in-flight release run** (if there is one) — native `gh run cancel`.
2. **Deprecate + repoint `latest`** for any bad version that already shipped —
   `scripts/deprecate.js`.

The environment gate (approver required) is what prevents new _automated_ publishes from proceeding
during an incident: as long as the approver refuses to click, nothing publishes. That is the natural
pause point; no separate pause primitive is needed.

### Platform limits — what we can and can't do

Our response is bounded by what git and npm allow. Being honest about what is _missing_ from these
platforms:

**What we would want (and can't have) on npm:**

-   A **scope-wide publish freeze** switch — "no new versions accepted for `@dappfence/*` until I
    say so." Would collapse incident response to one toggle.
-   A **"trusted-publisher-only" package mode** — reject any publish attempt that doesn't come
    through OIDC from our workflow. Removes the "compromised laptop = arbitrary publish" gap
    entirely. PyPI has this; npm doesn't.
-   **Remote session invalidation** — force-logout every active session on an account. Would let us
    respond to a compromised maintainer laptop in seconds instead of the minutes-hours it takes them
    to rotate password + 2FA seed.
-   A **per-role deprecate permission** separate from publish — currently anyone who can deprecate
    can also publish, so we can't give a security-response person deprecate rights without also
    giving them the ability to release.
-   A **safe rollback** — currently the only rollback is `npm dist-tag add ...@prev latest`, which
    is fine for the default install but doesn't help consumers who pinned the bad version.
    `unpublish` would help but is a DoS.

**What we would want (and can't have) on git/GitHub:**

-   A **"pauser" role** between Write and Admin — can trigger a specific workflow but can't modify
    settings, delete branches, or change permissions.
-   **Enforceable tag immutability** — the tag ruleset can be relaxed by any admin, so the "no
    delete" rule is only as strong as admin discipline. A repo option like "release tags are
    permanent and cannot be deleted even by admins" would harden the audit trail.
-   **Signature-persisting rebase** — rebase re-authors commits and drops GPG/SSH signatures. Every
    reflow of history means resigning. The only way to keep signatures is to not rebase.
-   **Atomic multi-package publish** — currently five workspaces = five upload calls. A partial
    failure leaves a partial release. This is a client-side limit as much as npm; we could improve
    by staging locally then confirming, but the risk stays.

**What this means in practice:** the design goal is **reduce time-to-detect and time-to-mitigate**,
because time-to-prevent is bounded by the above. Every emergency will feel unsatisfying because
we're always cleaning up after, not stopping in flight.

### Best we can actually do in an emergency

Given the limits above, this is the whole playbook:

1. **If a release run is in-flight and not yet approved:** the approver refuses to click. Nothing
   further happens. This is the natural pause.
2. **If a release run is past approval and mid-publish:** `gh run cancel <run-id>`. Some packages
   may already have shipped; see step 4 for cleanup.
3. **If the incident is a compromised laptop/session:**
    - The maintainer immediately `npm logout` + `gh auth logout` on all devices
    - Rotate the npm password + 2FA seed via the browser
    - Revoke every npm access token owned by the account
    - If a signing key is suspected exposed: remove from `.github/release-keys/*.pub` via PR
    - Notify all other maintainers out-of-band
4. **If a bad version already shipped:** `node scripts/deprecate.js sunset <version> "<reason>"` —
   deprecates + repoints `latest` to the prior stable version. Consumer `npm install` returns the
   safe version; consumer `npm ci` on a pinned lockfile still succeeds (no DoS).
5. **Publish a Security Advisory** (see
   [SECURITY_ADVISORY_TEMPLATE.md](../.github/SECURITY_ADVISORY_TEMPLATE.md)) so the deprecation
   reason has a URL to point at.
6. **Cut the patched version** through the normal release ceremony.
7. **Post-mortem within 7 days.** What went undetected, what gate should have caught it.

That is genuinely everything. There is no button that stops the world; the ceremony above is what we
get.

### Cancel an in-flight release

If a release workflow is running and needs to be aborted (e.g. tag verified but you notice the diff
is wrong, or a check step is stuck):

```bash
gh run list --workflow=release.yml --limit 3
gh run cancel <run-id>
```

Any maintainer with `actions:write` on the repo can cancel. Cancellation is immediate for steps that
haven't started; steps already running finish. If the run is past the `production-publish` approval
and mid-publish, `gh run cancel` may not stop individual `npm publish` calls that already succeeded
— use `scripts/deprecate.js` to sunset whatever escaped.

If the release hasn't been approved yet: just don't approve. That is the pause.

## Incident response — deprecate a bad release

If a released version has a severe bug or security issue, you need to react in minutes, not hours.
The design intent: never touch tarballs (that causes DoS for pinned consumers), only steer new
installs away from the bad version.

**Two safe operations:**

-   `npm deprecate <spec> "<reason>"` — adds a warning at install time. Tarballs stay reachable;
    `npm ci` on a lockfile that pins the bad version still succeeds (no DoS). Fully reversible
    (deprecate with empty string un-deprecates).
-   `npm dist-tag add <spec> latest` — repoints the `latest` tag to a known-good version. New
    `npm install @dappfence/core` (no version specified) resolves to the new target instead of the
    bad one. Existing lockfiles unaffected.

**One operation to _never_ use:**

-   `npm unpublish` — removes tarballs, breaking every consumer whose lockfile pins the removed
    version. Also creates a 24h window during which the name+version cannot be re-registered. This
    _is_ a DoS. Not an incident tool.

`scripts/deprecate.js` wraps both safe operations across all publishable `@dappfence/*` packages
atomically. Prerequisite: `npm whoami` must succeed on your machine (i.e. `npm login` recently).
Trusted Publishing credentials do NOT cover deprecate/dist-tag — you need a maintainer session.

### Runbook — severe issue in the latest release

Timeline goal: detection → new installs safe in **under 10 minutes**.

```bash
# 1. Confirm the bad version and pick the last known-good one
npm view @dappfence/core versions --json

# 2. Sunset the bad version (deprecate + repoint 'latest' to prior stable)
node scripts/deprecate.js sunset 0.2.0 "SECURITY: <one-line summary>; see https://github.com/coinspect/dappfence/security/advisories/<slug>"
```

`sunset` will print a plan and require you to type `yes` before executing. Under the hood: it runs
`npm deprecate` for every publishable package at that version, then `npm dist-tag add ... latest` to
repoint each to the auto-selected previous stable version.

If you need to undo (e.g. false alarm):

```bash
node scripts/deprecate.js undeprecate 0.2.0
node scripts/deprecate.js repoint-latest 0.2.0
```

### Runbook — severe issue in a non-latest version

If the bad version is not currently `latest`, skip the repoint:

```bash
node scripts/deprecate.js deprecate 0.1.4 "SECURITY: <summary>; advisory: <url>"
```

Only the install-time warning fires; no dist-tag movement.

### Sunsetting old versions (proactive, not incident)

To nudge consumers off ancient versions before they become an issue, deprecate with a soft message:

```bash
node scripts/deprecate.js deprecate 0.0.9 "please upgrade to >=0.2.x; 0.0.x is unmaintained"
```

Do this deliberately, one version at a time. Do **not** batch-deprecate a whole range unless every
version in the range is known-broken — mass deprecation looks like a compromise from a consumer's
perspective and erodes trust.

### After any incident action

-   Publish a GitHub Security Advisory (`Security` tab → **Advisories** → **New draft**) with
    affected versions, symptoms, and workaround. This is the URL you reference in the deprecate
    reason.
-   Cut the fixed patch release through the normal release ceremony. Do not backport by publishing
    over the old bad version — you can't. Publish a new patch version and repoint `latest` to it.
-   File a post-mortem issue in the repo within 7 days. What went undetected, what gate should have
    caught it, what to add to the pipeline.

## What to do if it goes wrong

-   **Tag signature verification fails** — your key is not enrolled, or `user.signingkey` points at
    a different key than the one in `release-keys/`. Fix locally, delete + re-sign + re-push the tag
    (only safe if nothing has consumed it yet).
-   **Publish fails with "no matching Trusted Publisher"** — the workflow filename, environment
    name, org, or repo in the npm Trusted Publisher config does not match. Recheck Step 4.
-   **Publish fails with "You cannot publish over the previously published versions"** — the tag
    version is not greater than the latest published version. Bump and re-tag.
-   **Monitor fires an ALARM you did not cause** — treat as a potential incident. Do not publish
    anything else until it is understood.
