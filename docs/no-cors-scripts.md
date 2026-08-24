# No-CORS Script Handling

## The problem

When a browser loads a script without a `crossorigin` attribute, it uses `mode: no-cors`:

```html
<script src="https://external-cdn.com/lib.js"></script>
```

A `no-cors` fetch succeeds even if the server sends no CORS headers, but the SW receives an **opaque
response**: `status: 0`, body unreadable. DappFence cannot hash-verify a body it cannot read, so it
cannot confirm the script is safe to execute.

## The solution: force_cors_scripts (default: on)

When the `force_cors_scripts` feature flag is enabled (the default), DappFence upgrades every
`no-cors` script request to `cors + credentials: omit` before fetching. This forces the server to
respond with `Access-Control-Allow-Origin`, making the body readable and hash-verifiable.

```
no-cors script request
  → SW upgrades to cors+omit
  → Server responds with Access-Control-Allow-Origin: *
  → Body is readable → hash verified against manifest
  → MATCH: script executes   |   MISMATCH/NOT_FOUND: security block
```

`credentials: omit` is unconditional: the re-fetch never sends cookies, client certificates, or
authorization headers, regardless of the original request's credentials setting.

## Hard requirement: the origin server must support CORS

If the server does not return `Access-Control-Allow-Origin`, the browser rejects the response and
the fetch throws a `TypeError`. DappFence re-throws `TypeError` so the browser sees a real network
failure — the script element fires `onerror` and the script never executes.

This is intentional. **DappFence can only verify scripts whose servers grant body access via CORS.**
If a CDN does not support CORS, the fix is on the CDN side, not in DappFence.

Major public CDNs (cdnjs, jsDelivr, unpkg, code.jquery.com, ajax.googleapis.com) all support CORS.

**Known incompatible cases:**

-   Legacy or private enterprise CDNs set up before CORS was widely adopted
-   JSONP endpoints serving JavaScript (predates CORS)
-   Some older analytics/ad-tech vendor scripts
-   Internal network resources (`intranet.corp`, private IP ranges)
-   Self-hosted assets on misconfigured CDNs

For these cases the recommended fix is to self-host the script so it is same-origin and requires no
CORS negotiation.

## Disabling the upgrade (force_cors_scripts: false)

Setting `force_cors_scripts: false` in `feature_flag.json` disables the CORS upgrade. No-cors script
requests are passed through unchanged, the server responds without CORS headers, and the SW receives
an opaque response.

The `file-verifier` detects the opaque response and returns `VERIFICATION_STATUS.REWRITE`, which
causes DappFence to serve an **empty stub** instead of the original script body. The script element
does not fire an error, but the script body never executes.

```
no-cors script request (flag off)
  → SW does not upgrade — original no-cors fetch
  → Opaque response (body unreadable)
  → file-verifier returns REWRITE
  → Browser receives empty stub — script does not execute
```

In both modes DappFence never passes through a script it cannot verify. The difference is
user-visible behaviour:

|                     | force_cors_scripts: true (default)           | force_cors_scripts: false                |
| ------------------- | -------------------------------------------- | ---------------------------------------- |
| CORS-capable server | Script verified and executes if hash matches | Script silently replaced with empty stub |
| Non-CORS server     | Network error (TypeError)                    | Script silently replaced with empty stub |

The default (flag on) is the stronger security posture: it surfaces misconfigured CDNs loudly rather
than silently blocking them.

## Allowing opaque scripts through — THIS IS A TERRIBLE IDEA

It is technically possible for a SW to return an opaque response from `respondWith()`. The browser
made a `no-cors` request expecting a script; it does not care that the SW cannot read the body — it
will execute whatever the server sent.

One might think: restructure `shouldSkipVerification` to check `contentRules` before the opaque
REWRITE, then let an `allow` rule pass the response through for specific trusted URLs. This would
work in the sense that the script executes. **Do not do this.**

An opaque response body is completely unreadable to the SW. There is no hash, no content check, no
integrity guarantee of any kind. If the CDN at that URL is compromised — cache poisoning, BGP
hijack, subdomain takeover — the attacker's script executes on every page load with no detection.
DappFence's entire security guarantee for that URL is gone.

The correct fix for a specific URL that needs to work is to **self-host it** so it is same-origin
and hash-verifiable. An allow rule for an opaque script is not an escape hatch — it is a hole.

## Why Origin cannot be forged

The SW lives at the app's origin (e.g., `https://example.com`). When it fetches a cross-origin URL,
the browser sets `Origin: https://example.com` — a forbidden header that cannot be overridden by
JavaScript. There is no mechanism to construct a "same-origin" fetch to a different domain from
within a SW. CORS support on the server is a genuine requirement, not a workaround.
