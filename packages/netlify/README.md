# Deploying DappFence to Netlify

This guide covers everything needed to deploy a DappFence-protected site to Netlify, including the
post-build processing pitfalls that can silently break hash verification.

## Required: disable Netlify post-build processing

Netlify can rewrite your files **after** the build completes and after DappFence has already
computed and signed the hashes. Any post-build modification breaks verification.

Add this to your `netlify.toml`:

```toml
[build]
command = "npm run build"
publish = "dist"

[build.processing]
  skip_processing = true

[build.processing.html]
  pretty_urls = false
```

`skip_processing = true` disables CSS/JS bundling and minification. `pretty_urls = false` is
required separately — it prevents Netlify from rewriting link hrefs in HTML files (e.g.
`/about.html` → `/about`).

> **Current limitation — CSS/JS minification:** Netlify's minification toolchain is internal and
> undocumented, so its output is not reproducible locally. There is currently no way to compute the
> post-minification hashes at build time. A future version of DappFence may support a
> post-processing hook that re-hashes files after Netlify transforms them.

> **Current limitation — `pretty_urls`:** The href rewrites are deterministic but touch every link
> in every HTML file. A strip rule could theoretically cover this, but the rewrite is pervasive
> enough that disabling it is the safer default. Future support for a `pretty_urls` strip rule is
> being considered.

## Netlify CDP analytics snippet

Netlify injects a CDP analytics `<div>` into every HTML page **at CDN serve time**, after the build
completes. DappFence handles this via the built-in `netlify-cdp` filter rule, which removes the
snippet from fetched HTML before hashing at verification time — so the hash still matches the
pre-injection content recorded in the manifest. The rule also covers the CDP script itself
(`/.netlify/scripts/cdp`): known-good hashes are verified and allowed through; unknown content is
replaced with an empty stub rather than blocking the page.

Filter rules are a closed set defined in the DappFence source. The manifest only references them by
name; arbitrary patterns cannot be injected through the manifest. See the
[DappFence README](../../README.md) for details.

The rule is **auto-detected** when any of the following environment variables are present at build
time: `NETLIFY`, `NETLIFY_SITE_ID`, `NETLIFY_BUILD_BASE`. This covers both Netlify's own build
runner and third-party CI (e.g. GitHub Actions) deploying to Netlify.

If auto-detection does not apply (e.g. building locally to test), enable the rule explicitly in your
DappFence configuration:

```js
// e.g. in astro.config.mjs, vite.config.js, or however you invoke DappFence
dappfence({
    filters: ['netlify-cdp'],
});
```

## Netlify Forms

Netlify detects `<form netlify>` attributes and injects a hidden input field into those forms after
the build:

```html
<input type="hidden" name="form-name" value="your-form-name" />
```

> **Current limitation — Netlify Forms:** DappFence has no strip rule for this injection. The
> inserted field is predictable in structure but varies by form-name value across HTML files, and
> there is currently no way to strip it reliably at verification time. A future version may add a
> `netlify-forms` strip rule.

Until then, **do not use Netlify Forms on a DappFence-protected site** — use a third-party form
backend (Formspree, a serverless function, etc.) that does not modify your HTML post-build.

## Netlify Snippet Injection (dashboard)

The Netlify dashboard allows injecting arbitrary HTML into `<head>` or `</body>` via **Site
configuration → Build & deploy → Post processing → Snippet injection**. Any snippet added there
modifies HTML bytes after hashing and breaks verification.

> **Current limitation — Snippet Injection:** Because the injected content is arbitrary and
> configured outside the build, DappFence cannot know its content at hash time. There is no general
> solution for this category; include any third-party scripts directly in your source instead.

Do not use dashboard snippet injection on a DappFence-protected site. Include any third-party
scripts directly in your source so they are hashed at build time.

## Environment variables

| Variable               | Where to set                                         | Description                                                            |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `DAPPFENCE_SECRET_KEY` | Netlify → Site configuration → Environment variables | Hex secret key used to sign the manifest. Never commit this to source. |

Generate a key locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deployment checklist

-   [ ] `skip_processing = true` in `netlify.toml`
-   [ ] `pretty_urls = false` in `netlify.toml`
-   [ ] `DAPPFENCE_SECRET_KEY` set in Netlify environment variables
-   [ ] No Netlify Forms (`<form netlify>`) in source
-   [ ] No Snippet Injection configured in the Netlify dashboard
-   [ ] `strips: ['netlify-cdp']` in DappFence config (only needed when building outside Netlify)
