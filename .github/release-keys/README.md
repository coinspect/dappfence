# Release keys

SSH public keys of maintainers authorized to sign release tags. The `release.yml` workflow builds an
OpenSSH `allowed_signers` file from every `*.pub` in this directory and rejects any tag whose
signature does not verify against it.

## File format

One file per maintainer, named `<handle>.pub`, containing a single line:

```
ssh-ed25519 AAAAC3Nz... comment
```

Any SSH key type supported by OpenSSH signing works (`ssh-ed25519`, `ssh-rsa`,
`sk-ssh-ed25519@openssh.com`, etc.). Ed25519 is preferred. Hardware-backed keys (YubiKey via
`sk-ssh-ed25519@openssh.com`) are strongly preferred over on-disk keys.

## Adding a key

You can enroll:

-   **Your existing GitHub push key** (simplest — same key signs and pushes). Trade-off: stealing
    that key grants both push and release-signing authority.
-   **A separate signing key**, ideally hardware-backed. Stronger — stealing your laptop key does
    not grant release authority.

The workflow does not care which SSH key it is; only the `.pub` files committed here are trusted.
Your GitHub push key is **not** auto-included.

1. If enrolling a new dedicated key, generate one:

    ```bash
    ssh-keygen -t ed25519 -f ~/.ssh/dappfence-release
    ```

    Or for YubiKey (touch-required, non-extractable):

    ```bash
    ssh-keygen -t ed25519-sk -O resident -O verify-required -f ~/.ssh/dappfence-release-sk
    ```

    If reusing your push key, skip generation.

2. Open a PR adding your public key as `.github/release-keys/<your-github-handle>.pub`. The PR must
   be reviewed by at least one existing maintainer.

3. Configure your local git to sign with this key:

    ```bash
    git config --global gpg.format ssh
    git config --global user.signingkey ~/.ssh/dappfence-release.pub
    ```

    (Do not set `commit.gpgsign` — only tags need signing.)

## Removing a key

Any maintainer may open a PR removing a key. Removal takes effect on the next release. If removal is
prompted by suspected key compromise, escalate to an incident and treat any release signed by the
affected key that has not yet been reviewed as suspect.

## Why this exists in-repo

Storing the allowlist in the repo means every workflow run verifies against the version of the
allowlist as of the tag commit — so a compromised admin cannot add a key to the allowlist and
retroactively make an earlier tag verify. Changes to this directory are auditable via `git log`.
