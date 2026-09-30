# Security Policy

> ⚠️ **DappFence is in alpha and not intended for production use.** The security model, packaging,
> and release pipeline are still stabilizing. See the alpha notice in the [README](../README.md).

## Supported versions

While in alpha, only the most recent `-alpha.N` (or `-rc.N`, `-beta.N`) prerelease of each
`@dappfence/*` package receives security fixes. Once we cut a stable `1.0.0`, this section will be
updated with a formal support matrix.

| Package                     | Supported                                             |
| --------------------------- | ----------------------------------------------------- |
| `@dappfence/core`           | latest prerelease under the `alpha` npm dist-tag only |
| `@dappfence/manifest-tools` | latest prerelease under the `alpha` npm dist-tag only |
| `@dappfence/astro`          | latest prerelease under the `alpha` npm dist-tag only |
| `@dappfence/next`           | latest prerelease under the `alpha` npm dist-tag only |
| `@dappfence/test-app`       | not supported for production; dev/test tooling only   |

## Reporting a vulnerability

**Do not open a public issue.** Report privately via GitHub's security advisory flow:

**→ [Report a vulnerability](https://github.com/coinspect/dappfence/security/advisories/new)**

That link opens a private form only maintainers can see. It becomes the coordination thread for the
disclosure.

Please include:

-   Affected version(s) and package(s)
-   A minimal reproduction (steps or code)
-   Observed vs. expected behavior
-   Suspected impact (what an attacker could do)
-   Your preferred credit (name / handle / affiliation, or anonymous)

If you cannot use the GitHub form, email `security@coinspect.com`. Do not attach exploit code
unencrypted; request our PGP key first.

## What we consider in scope

-   Bypass of DappFence's content-verification guarantees (frontend tampering not detected)
-   Cryptographic mistakes in signing, hashing, or manifest verification
-   Supply-chain issues in `@dappfence/*` packages (malicious dep, tampered tarball, missing
    provenance)
-   Vulnerabilities in the release pipeline itself (`release.yml`, `monitor.yml`, `scripts/*`)
-   Issues that let an attacker cause DappFence to allow content it should have blocked

## What we consider out of scope

-   Vulnerabilities in `@dappfence/test-app` when used only as a dev-server (it is not a production
    runtime)
-   Denial-of-service via a compromised source website (DappFence's threat model assumes a
    compromised origin; blocking bad content is the point, not maintaining availability of it)
-   Issues that require the attacker to already have publish access to `@dappfence` on npm
-   Reports generated exclusively by automated scanners without a working proof of concept
-   Best-practice deviations that do not reduce a concrete security property

## Response expectations

-   Acknowledgement within **72 hours** of your report (usually faster).
-   Triage decision (in scope / out of scope / needs more info) within **7 days**.
-   For confirmed in-scope issues, a fix plan within **14 days**, and a coordinated release when the
    fix is ready.
-   Public advisory published on the day the patched version is released, or at a coordinated
    disclosure date if we agree one with you.

If we go silent, ping the private advisory thread and CC `security@coinspect.com`.

## Credit

We credit reporters by name/handle in the published advisory unless you ask us not to. If you
request anonymity, we honor it.

## Related documentation

-   [Release setup and incident response runbook](../docs/release-setup.md)
-   [Security advisory template](./SECURITY_ADVISORY_TEMPLATE.md) (internal, used by maintainers
    when drafting an advisory)
