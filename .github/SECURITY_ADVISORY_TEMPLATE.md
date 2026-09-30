# Security Advisory Template

Fill this in when drafting a GitHub Security Advisory. Copy-paste the sections into repo →
**Security** → **Advisories** → **New draft**. Do not commit filled-in advisories back to the repo —
the draft form is the source of truth once you start.

---

## Title

`<one-line summary — e.g., "Signed manifest verification bypass in @dappfence/core <=0.2.3">`

## Ecosystem

npm

## Affected package(s)

-   `@dappfence/core` — versions: `<range or list>`
-   `@dappfence/manifest-tools` — versions: `<range or list>`
-   `@dappfence/astro` — versions: `<range or list>`
-   `@dappfence/next` — versions: `<range or list>`
-   `@dappfence/test-app` — versions: `<range or list>`

(delete entries that are not affected)

## Patched version(s)

`>=X.Y.Z` — release the patched version through the normal ceremony before publishing this advisory,
so the "upgrade to X.Y.Z" advice is actionable at the moment consumers see the warning.

## Severity

CVSS 3.1 score: `<0.0 – 10.0>` (`<Low|Medium|High|Critical>`)

Vector: `<CVSS vector string, e.g., CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N>`

## Weakness

CWE-`<id>`: `<name>` (e.g., CWE-347: Improper Verification of Cryptographic Signature)

## Description

`<one paragraph explaining what the bug is and how it can be exploited>`

Include: what code path is affected, what an attacker with what access can do, what the observable
consequence is for a consumer running the affected version.

## Impact

`<one paragraph on the real-world impact>`

Who is affected (all consumers? only consumers using feature X?), what protection is bypassed,
whether exploitation requires user interaction, whether it is remotely exploitable.

## Patches

The fix landed in `<version>` (commit `<sha>`, PR `#<num>`).

`<brief description of the fix — what changed and why it closes the issue>`

## Workarounds

`<if any exist, list them; otherwise write "None — upgrade to <patched version>.">`

Examples of legitimate workarounds:

-   "Disable feature X in your configuration"
-   "Restrict access to endpoint Y until upgraded"

## References

-   Fix commit: `https://github.com/coinspect/dappfence/commit/<sha>`
-   Fix PR: `https://github.com/coinspect/dappfence/pull/<num>`
-   Related discussion: `<url if any>`

## Credit

`<reporter's name/handle and affiliation, if they consent>`

If reported through the private disclosure process, ask before naming.

## Timeline

-   `YYYY-MM-DD` — reported by `<reporter>`
-   `YYYY-MM-DD` — triaged, root cause confirmed
-   `YYYY-MM-DD` — fix landed in main (`<commit>`)
-   `YYYY-MM-DD` — patched version `<version>` published
-   `YYYY-MM-DD` — bad version(s) deprecated on npm via `scripts/deprecate.js`
-   `YYYY-MM-DD` — advisory published

---

## After publishing the advisory

1. **Reference this advisory URL in every deprecation message** — update the deprecation reason to
   point at the advisory URL if it was published after the initial deprecate call.
2. **Notify customers out-of-band** through the channels documented in the project's disclosure
   policy.
3. **Open a post-mortem issue** within 7 days. What went undetected, what gate should have caught
   it, what to add to the pipeline.
