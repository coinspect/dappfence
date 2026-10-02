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

A release is authorized by an SSH-signed git tag matching `release-*` (e.g. `release-1`,
`release-2026-04-01`) — the tag string itself carries no version information, and pushing it doesn't
start anything by itself (see "Release ceremony" below for why). Its only jobs are to be the signed
artifact that authorizes "publish whatever `package.json` versions are checked in at this commit"
and to be unique per release event. What actually gets uploaded to npm is decided per package: for
each of the five publishable packages, if its current `package.json` version isn't already published
on npm, it publishes; if it's already live (unchanged since the last release), it's silently
skipped. This is what lets one release carry a single-package PATCH bump without needing to
force-republish everything else.

## Why the pipeline is three jobs

`release.yml` is split into `verify` → `build` → `publish`, and the split is a security boundary
rather than organisation. **Do not merge these back together.**

npm Trusted Publishing has no stored token. The credential is minted on demand from two environment
variables that `permissions: id-token: write` injects into a job:

```
ACTIONS_ID_TOKEN_REQUEST_URL
ACTIONS_ID_TOKEN_REQUEST_TOKEN
```

Any process in that job can read them, request an OIDC JWT with the `npm:registry.npmjs.org`
audience, and `POST` it to npm's `/-/npm/v1/oidc/token/exchange/package/<name>` endpoint to receive
a real publish token. That is roughly ten lines of `curl` — it is not a privileged npm CLI path. The
JWT's claims describe the repo, the workflow filename and the environment, so one minted by a unit
test is indistinguishable from one minted by the publish step, and all the version/allowlist checks
in that step are simply skipped by code that mints its own.

GitHub scopes permissions per job, never per step. So the only control available is how little runs
in the job that holds the token:

| Job       | Holds the npm credential | Runs repository code                                                        |
| --------- | ------------------------ | --------------------------------------------------------------------------- |
| `verify`  | no                       | signature/ancestry checks, `sync-versions.js check`                         |
| `build`   | no                       | **everything** — `npm run check`, 36 unit tests, the Vite build, `npm pack` |
| `publish` | **yes**                  | nothing — no checkout at all                                                |

`publish` deliberately has no `actions/checkout`. It consumes the tarballs `build` uploaded, reads
each one's name and version out of the tarball itself with `tar` + `jq`, checks them against the
allowlist `verify` exported, and uploads with `npm publish <file>.tgz --ignore-scripts`. Publishing
a prebuilt tarball runs no lifecycle scripts, so `@dappfence/core`'s build happens in `build`
instead (with `COMMIT_HASH` set exactly as its `prepublishOnly` used to set it).

Note `id-token: write` cannot be avoided by going back to an `NPM_TOKEN` secret: sigstore reads the
_same_ two variables to sign provenance, so `--provenance` needs it regardless. A token would
reintroduce a long-lived secret and keep this exposure.

What the split does **not** solve: `build` still runs unreviewed code and still produces the
tarballs, so a malicious build config can shape what ends up inside them. That is inherent to
building from source; the mitigation is CODEOWNERS covering build-affecting files (Step 1). The
split is what stops that code from obtaining publish authority outright.

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

Know its boundary: even fully enforced, CODEOWNERS governs **pull requests into `main`**. It says
nothing about a file on some other branch, so it alone does not stop someone from pushing a side
branch with a doctored `release.yml` and dispatching it. Step 3's deployment-branch restriction is
the control that closes that path; the two are complements, and neither is sufficient alone.

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
2. Under **Deployment protection rules**: enable **Required reviewers**, add the maintainer team,
   and enable **Prevent self-review** — without this explicitly checked, the workflow's initiator
   can approve their own run, defeating the two-person-control this gate exists for. Optionally
   enable a **Wait timer**.
3. Under **Deployment branches and tags**, choose **Selected branches and tags** and allow the
   protected `main` branch. **This is a security control, not a convenience setting — do not leave
   it on "No restriction".**

    `workflow_dispatch` lets the dispatcher choose which branch to run from, and the workflow file
    that executes is the copy **on that branch**. npm's Trusted Publishing matches on
    org/repo/workflow-**filename**/environment — the branch is not part of the match. So anyone who
    can push a branch to this repo could push a branch carrying a `.github/workflows/release.yml`
    with the signature check and the main-ancestry check deleted, dispatch it, and npm would still
    mint a publish credential for it: same filename, same environment, same repo. CODEOWNERS does
    not stop this either — it governs pull requests into `main`, not what sits on a side branch.
    Restricting deployments to `main` is what closes that path, because it means the only copy of
    the workflow that can ever reach this environment is the reviewed one on the protected branch.

    Note that an equivalent check _inside_ the workflow (e.g. asserting `github.ref`) would be
    worthless against this attack — in the scenario above the attacker is editing the workflow, so
    they would simply delete the assertion too. The control has to live in the environment
    configuration, outside anything the dispatched ref can modify.

    Allow the **branch**, not a `release-*` tag pattern. A dispatch run's real git ref is the branch
    you launch from; the `tag` input is just a string parameter read inside the job. A `release-*`
    restriction would never match any run's actual ref, and would block the `publish` job before it
    ever reached the approval step. The tag itself is independently verified by the `verify` job.

4. Save. No secrets needed here — Trusted Publishing uses OIDC.

### Step 4 — Protect the `release-*` tag namespace

Repo → **Settings** → **Rules** → **Rulesets** → **New tag ruleset**:

-   Target: tag pattern `release-*`
-   Enforcement: **Active**
-   Rules: **Restrict creations** (maintainer team only), **Restrict updates** and **Restrict
    deletions** (disallow both for everyone — release tags are immutable). Restricting only creation
    and deletion still lets an existing tag be force-moved to point at a different commit, which is
    exactly the window the SHA-pinning in `release.yml` closes on the workflow side — this closes it
    at the git level too. Leave GitHub's own **Require signatures** off — signatures are verified in
    the workflow against the `RELEASE_SIGNING_KEYS` repository variable instead.

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

`release.yml` only runs via `workflow_dispatch` — pushing a signed tag does **not** start anything
by itself; it just creates the artifact the workflow will later verify. That split is deliberate:
it's what makes a real dry run possible. If pushing the tag auto-started a real run, a
manually-dispatched dry run against that same tag would just queue behind it (same `release`
concurrency group) — by the time the dry run got anywhere, the real one would already be live.
Because dispatching is always a separate, explicit step, you can safely dry-run first and only
dispatch for real once you're satisfied.

The version bump has to land on `main` through a normal reviewed PR first — `release.yml` now
refuses to release a tag whose commit isn't reachable from `main` (Step 1's whole point), so tagging
a local commit you haven't merged yet will fail at the `verify` job.

**Tag names are single-use.** Step 4's ruleset restricts updates and deletions, so once a
`release-*` tag is pushed, that name is spent permanently — it cannot be moved or removed, even by
an admin, and even if the run it was created for failed. Every subsequent attempt needs a brand-new
name. The `release-$(date +%Y%m%d)` convention below therefore collides on the second release of any
given day: append a counter (`release-20261001-2`, `-3`, …) when the plain date is already taken. A
spent tag left behind on the remote is harmless — dispatching is manual, so nothing fires from a
tag's existence.

**A coordinated release (MAJOR.MINOR bump, or several packages' PATCHes at once):**

```bash
node scripts/sync-versions.js bump-major-minor 0.2 --apply
git checkout -b release/0.2
git commit -am "chore: release 0.2 line"
git push origin release/0.2
# open a PR, get it reviewed and merged to main, then:
git checkout main && git pull
git tag -s release-$(date +%Y%m%d) -m "Release 0.2 line"
git push origin release-$(date +%Y%m%d)
```

**A single-package PATCH release:**

```bash
node scripts/sync-versions.js bump-patch @dappfence/vite --apply
git checkout -b release/vite-patch
git commit -am "chore(vite): release patch"
git push origin release/vite-patch
# open a PR, get it reviewed and merged to main, then:
git checkout main && git pull
git tag -s release-$(date +%Y%m%d) -m "Release @dappfence/vite patch"
git push origin release-$(date +%Y%m%d)
```

**Then, always, dry run first:** Actions → `Release` → **Run workflow** → enter the tag you just
pushed → `dry_run: true`. The full pipeline runs for real — tag verify, main-ancestry check,
MAJOR.MINOR check, install, checks, audits, tests, pack, then `npm publish --dry-run` against the
real tarballs — with no upload at the end. Confirm it's clean.

Note the dry run **also pauses at the `production-publish` environment** and needs a second
maintainer to approve it, exactly as the real run does: `dry_run` only decides whether `npm publish`
is given `--dry-run`, and the job targets that environment unconditionally. So a release takes two
approvals, and you cannot complete a dry run by yourself. That is deliberate — a dry run that
skipped the gate would not be exercising the path the real run takes — but it does mean lining up
your approver before you start, rather than discovering the pause halfway through.

**Then the real run:** Actions → `Release` → **Run workflow** → the same tag → `dry_run: false`. It
pauses at the `production-publish` environment — ask a second maintainer to approve. Once approved,
whichever packages actually changed version publish with `--provenance`; everything already at its
current version on npm is skipped, not re-uploaded.

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
-   If it needs a build step to produce shippable output, add that build explicitly to the `build`
    job in `release.yml`, before the pack loop — the way `@dappfence/core`'s Vite build is invoked
    there. A `prepublishOnly` script will **not** do it: `publish` uploads prebuilt tarballs with
    `--ignore-scripts`, so package lifecycle scripts never run during a release.
-   Configure an npm Trusted Publisher for it (Step 5 above) — the workflow fails with "no matching
    Trusted Publisher" on its first publish otherwise.
-   Make sure it's covered by `npm run check`. Its unit tests are picked up automatically — the
    workflow derives that list from `packages/publish.json`, so adding it there is enough. Anything
    reachable from those runs, and blocks, every release.

## If it goes wrong

**First, the rule that governs every recovery below:** a pushed `release-*` tag can never be moved,
deleted or reused (Step 4). Recovery is always "push a **new**, uniquely named signed tag", never
"fix the old one". Deleting the bad tag from your _local_ clone is fine and unrestricted; it's the
remote that's immutable. The spent tag stays on the remote for good, which costs nothing — runs are
dispatched by hand, so an abandoned tag never triggers anything.

-   **Tag signature verification fails** — your key isn't enrolled in the `RELEASE_SIGNING_KEYS`
    repository variable, the line for it doesn't match the exact `allowed_signers` format, or
    `user.signingkey` points at a different key than the one enrolled. The tagged commit is fine;
    only the signature is bad. Fix the signing setup, then sign and push a new tag against the same
    commit — no new PR needed:

    ```bash
    git tag -d release-20261001                       # local only
    git tag -s release-20261001-2 -m "Release 0.2 line"
    git push origin release-20261001-2
    ```

-   **`sync-versions.js check` fails** — a publishable package's MAJOR.MINOR doesn't match the rest.
    This one needs a new commit, not just a new tag, and `release.yml` refuses any tag whose commit
    isn't reachable from `main` — so the fix has to go through a reviewed PR before it can be
    tagged. Run `node scripts/sync-versions.js bump-major-minor <X.Y> --apply`, open a PR, merge it,
    then tag the merged commit with a new name.
-   **Publish fails with "no matching Trusted Publisher"** — the workflow filename, environment
    name, org, or repo in the npm Trusted Publisher config doesn't match. Recheck Step 5.
-   **Publish fails with "You cannot publish over the previously published versions"** — that
    package's version isn't actually new. Same shape as the `check` failure above: bump it with
    `bump-patch`/`bump-major-minor`, land it on `main` via a reviewed PR, then tag that merged
    commit with a new name.
-   **Nothing published at all, workflow succeeded** — every publishable package was already at its
    current version on npm; nothing had actually changed. Not an error.

## Not yet built (possible future additions)

-   A scheduled monitor verifying published packages still carry a valid registry signature and
    provenance attestation (drift detection).
-   `npm deprecate`/`dist-tag` incident-response tooling and a runbook for sunsetting a bad release.
-   Pinning intra-workspace `"*"` dependencies to real ranges for real npm consumers.
