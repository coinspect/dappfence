# Page Templates — HTML Partials and Modular CSS

How `@dappfence/core` builds the HTML pages it shows to users: the **security warning** page (served
by the service worker when content is blocked) and the **emergency panel** (injected by the client
when the watchdog database is force-closed). Both pages are assembled at build time from shared HTML
partials and shared CSS files, then inlined into the bundle as strings.

Everything lives in `packages/dappfence/src/templates/`, except the text, which lives in
`packages/dappfence/src/messages/` (see [Text and translations](#text-and-translations)). There are
no runtime fetches: a page is a single string with its CSS inside a `<style>` tag, because it must
render even when the site itself can no longer be trusted.

## Layout

```
src/templates/
  pages/                      one file per page; built from partials
    security-warning.html
    emergency-panel.html
  partials/                   HTML fragments shared by pages
    head.html                 <meta> tags, <title>{{title}}, the styles slot
    footer.html               "Protected by" + the DappFence logo; every page includes it
    logo.html                 DappFence logo (isotype + wordmark); include it as often as needed
    block-templates.html      <template> markup for the warning page's block cards
  assets/                     designer's SVG exports, colours as --df-logo-* tokens
    iso.svg                   DappFence isotype; logo.html inlines it
    logo.svg                  DappFence wordmark; logo.html inlines it
  styles/
    tokens.css                --df-* design tokens (colour, semantic variants, radius, font, logo palette)
    themes.css                dark theme: OS preference, or forced with .df-theme-dark / -light
    base.css                  reset and body defaults
    components/               one file per reusable component
      badge.css  block.css  button.css  callout.css  card.css  disclosure.css  footer.css
      info-row.css  logo.css  page.css
    pages/                    one entry stylesheet per page
      security-warning.css
      emergency-panel.css
```

Supporting code:

| File                                               | Role                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/dappfence/build/html-includes.js`        | Vite plugin that expands `<!-- @include -->` (`?template`)                      |
| `packages/dappfence/src/core/template.js`          | `renderTemplate(html, css)`: puts the CSS into the page                         |
| `packages/dappfence/src/sw/response.js`            | Renders the security warning page, adds `DAPPFENCE_CONFIG`                      |
| `packages/dappfence/src/client/emergency-panel.js` | Renders the emergency panel and shows it with its guards (`showEmergencyPanel`) |
| `packages/dappfence/preview/`                      | Template preview app (`npm run dev:templates`), see [Previewing](#previewing)   |

## How a page is built

```
pages/security-warning.html ──?template──▶ html-includes plugin ──▶ HTML string (partials expanded)
styles/pages/security-warning.css ──?inline──▶ Vite CSS pipeline ──▶ CSS string (@imports inlined, minified)
                                                                          │
                       renderTemplate(html, css)  ◀───────────────────────┘
                                 │
                 response.js: splice in DAPPFENCE_CONFIG ──▶ Response
```

1. **HTML.** `import html from '../templates/pages/security-warning.html?template'`. The `?template`
   query is handled by `build/html-includes.js`, which returns the page with every include expanded.
2. **CSS.** `import css from '../templates/styles/pages/security-warning.css?inline'`. This is
   Vite's built-in `?inline` import: it inlines relative `@import`s and minifies in production
   builds. No plugin or preprocessor is involved.
3. **Assemble.** `renderTemplate(html, css)` replaces the `/* @styles */` marker (inside the
   `<style>` tag of `partials/head.html`) with the CSS. Both callers do this once, when the module
   loads.
4. **Per-request data.** Only the security warning page has any. `response.js` replaces the
   `<script id="dappfence-config">` placeholder with the encoded block list on every render (see the
   comments in `createSecurityPageResponse`).

## HTML partials

### Include syntax

```html
<head>
    <!-- @include ../partials/head.html title="Security Warning - Content Blocked" -->
</head>
```

-   The directive must be alone on its line.
-   The path is **relative to the file that contains the directive**.
-   `key="value"` attributes fill `{{key}}` placeholders **in the included file only**. They are
    plain text substitutions, not escaped, so only put static, author-written strings there.
    `{{key=value}}` gives a placeholder a default.
-   Included content is re-indented to the directive's indentation, so the expanded page stays
    readable when you debug a bundle.
-   Includes can nest.

### Build errors

The plugin stops the build (and fails the tests) when:

| Condition                                       | Error message contains                   |
| ----------------------------------------------- | ---------------------------------------- |
| Included file doesn't exist                     | `cannot read … (included from …)`        |
| A file includes itself, directly or indirectly  | `include cycle: a -> b -> a`             |
| A path resolves outside `src/templates/`        | `… is outside …`                         |
| A `{{placeholder}}` has no attribute or default | `no value for {{key}}`                   |
| An `id-prefix` isn't a valid id start           | `id-prefix "…" must start with a letter` |
| The expanded page repeats an `id`               | `duplicate id "…"`                       |

There is no fallback output: a broken template never reaches a bundle.

### Reproducible builds

Release builds must reproduce byte-for-byte (`release.yml` refuses to publish otherwise). The plugin
only does string work on source files: no clock, environment, absolute paths or file ordering enter
the output. Keep it that way if you extend it. To check, build twice and compare
`sha256sum dist/*.js`.

### `<template>` elements for dynamic markup

Markup that the page script repeats at runtime (the warning page's block cards) is written as HTML
in `partials/block-templates.html`, not built with `createElement` chains:

```html
<template id="df-tpl-file">
    <details class="df-file">
        <summary class="df-file__row df-disclosure">
            <span class="df-file__key" data-slot="name"></span>
            <span class="df-file__hash" data-slot="hash"></span>
            <span class="df-badge" data-slot="count"></span>
        </summary>
        <div class="df-file__body" data-slot="body"></div>
    </details>
</template>
```

The page script clones it and fills the elements marked `data-slot`:

```js
const row = cloneTemplate('df-tpl-file');
fillName(slot(row, 'name'), block.fileKey || 'Unknown');
```

Rules:

-   **`data-slot` is the contract between markup and script**, not class names. CSS classes can be
    renamed without touching the script, as long as the `data-slot` attributes stay.
-   An optional slot that doesn't apply is **removed** (`el.remove()`), not left empty. CSS grid
    layouts such as `.df-file__row` depend on this.
-   Block data comes from the network and is untrusted. Write it with **`textContent` or `title`
    only, never `innerHTML`**.
-   Template ids use the `df-tpl-` prefix.

## CSS

### Why plain CSS, no preprocessor

Custom properties already give us variables and theming; `@import` plus Vite's `?inline` gives us
multiple files bundled into one string. A preprocessor (Sass, Stylus) would add mixins and loops
these pages don't need, at the cost of new build-time dependencies in a security product whose
releases must reproduce exactly. The source you read is the CSS that ships.

**Native CSS nesting is not used.** Vite flattens nested rules only in some build modes, and these
pages must render in older browsers too. Write flat selectors.

### Layers

Each page's entry file imports, in this order:

1. `tokens.css`: the `--df-*` variables. **Components use only these variables**, never raw colours,
   unless a colour is specific to one component variant (for example the asset-type chip colours).
2. `themes.css`: the dark tokens. Pages follow the viewer's OS preference (`prefers-color-scheme`);
   `.df-theme-dark` or `.df-theme-light` on `<body>` (or any element) forces a theme. The dark
   tokens are written twice, once per selector; a unit test keeps the two blocks identical. Every
   page imports it, so no page hard-codes a theme (also tested).
3. `base.css`: reset (`box-sizing`, zero margins) and page defaults. Only `<body>` paints a
   background, so a theme class on `<body>` also colours the whole window (the browser carries the
   `<body>` background out to the canvas when `<html>` has none).
4. `components/*.css`: only the components the page uses.
5. Page-specific rules, written in the entry file itself.

Media queries for a component (responsive sizes, `prefers-contrast`, `prefers-reduced-motion`) live
in **that component's file**, not the page file.

### Naming

BEM-style names with a `df-` prefix, so they can't collide with the host site's CSS:

| Pattern                  | Example                | Meaning                         |
| ------------------------ | ---------------------- | ------------------------------- |
| `.df-<block>`            | `.df-card`             | component                       |
| `.df-<block>__<element>` | `.df-card__header`     | part of a component             |
| `.df-<block>--<variant>` | `.df-callout--warning` | variant (combine with the base) |
| `--df-<token>`           | `--df-red-600`         | design token                    |
| `--df-<block>-<prop>`    | `--df-disclosure-size` | component setting               |

**Component settings** are custom properties a parent sets to adjust a component without a new
variant. For example, `.df-file__row` sets `--df-disclosure-size: 10px`, and `.df-file__body` sets
`--df-info-row-gap: 2px`.

IDs are only for elements the page script looks up (`#block-list`, `#site-unblock`, …). Don't style
by ID.

### Component reference

| File             | Classes                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `page.css`       | `.df-page`: full-viewport brand backdrop (`--df-bg`), card centred; wraps every page                                                     |
| `card.css`       | `.df-card` (`--raised`), `__header`, `__band` (`--brand/info/warn/error`), `__band-icon`, `__title`, `__body`, `__footer`, `__timestamp` |
| `button.css`     | `.df-btn`, `--danger`, `--brand`, `--info`, `--warn`, `--error`                                                                          |
| `badge.css`      | `.df-badge` (`--strong`), `.df-severity-chip`, `.df-chip` (`--service-worker`, `--manifest`)                                             |
| `callout.css`    | `.df-callout` (`--warning`, `--danger`), `__title`, `__text`                                                                             |
| `footer.css`     | `.df-footer`, `__label`                                                                                                                  |
| `logo.css`       | `.df-logo`, `__iso`, `__wordmark` (height via `--df-logo-height`, default 28px)                                                          |
| `disclosure.css` | `.df-disclosure`: put on a `<summary>` to get the rotating ▸ marker                                                                      |
| `info-row.css`   | `.df-info-row`, `__label`, `__value`, `__value--hash`                                                                                    |
| `block.css`      | `.df-block-list`, `.df-block` (`--group`), `.df-file-list`, `.df-file`                                                                   |

## Page-specific constraints

### Security warning (`pages/security-warning.html`)

-   It's a full document (`<!doctype html>`), served by the service worker at
    `/sw-api/security-warning`.
-   It sits on the brand page (`.df-page`) and follows the viewer's light/dark preference.
-   Its CSP is `default-src 'unsafe-inline' 'self'`, so CSS and scripts must stay inline. Don't link
    external stylesheets, fonts or images.
-   It must keep the `<script id="dappfence-config">` placeholder. `response.js` slices the page
    around it, and `src/sw/__tests__/response.test.js` checks that it's there.
-   End-to-end tests depend on the title `Security Warning - Content Blocked`, the heading text
    `Security Warning`, and a button named `Remove Site Lock`.

### Emergency panel (`pages/emergency-panel.html`)

-   It's a **fragment** (`<head>…</head><body>…</body>`, no doctype or `<html>`), because it
    replaces `document.documentElement.innerHTML` of an already-loaded page.
-   It sits on the brand page (`.df-page`) and follows the viewer's light/dark preference, like the
    security warning. Don't put a theme class on its `<body>`.
-   An end-to-end test depends on the `<h1>` text `Security Action Required`.
-   **No `<script>` in the markup.** Scripts inserted through `innerHTML` never run, so
    `showEmergencyPanel()` in `src/client/emergency-panel.js` attaches the behaviour after inserting
    the panel: a `beforeunload` confirmation and a capture-phase click handler that blocks links. A
    unit test fails if the panel gains a `<script>`, and `sw-clear-site-data.spec.ts` checks both
    guards in a real browser.

## Text and translations

No user-facing text is written in the templates. Every string lives in a message catalog, and pages
refer to it by key:

-   HTML: `{{t:warning.title}}`, filled at render time by `renderMessages(html, messages)`
    (`src/core/template.js`). It **HTML-escapes** every value, so message text can never add markup.
    `build/html-includes.js` leaves these markers alone (its `{{name}}` pattern doesn't match `t:`).
-   The warning page's inline script: `t('warning.confirmUnlock')`, reading
    `DAPPFENCE_CONFIG.messages`. Its output only goes to `textContent`, `title`, `confirm()` and
    `alert()`.
-   `src/sw/response.js`: the per-reason block views hold keys
    (`block.FILE_UNTRUSTED.HASH_MISMATCH`, `block.label.expectedHash`), resolved to text before they
    reach the page.

Placeholders inside a message use `{name}` (`"Blocked at {time}"`) and are filled by
`formatMessage`.

### Where text may come from

The emergency panel tells the user whom to contact. An attacker who could rewrite that line would
turn DappFence's own warning into their phishing page, so text only comes from sources an attacker
serving the site can't change:

| Source                                                    | Trusted                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Built-in catalogs, `src/messages/<locale>.json`           | Yes: compiled into `dappfence.js`, covered by the signed release hashes |
| `messages` in the integrity manifest                      | Yes, once its signature verifies against the pinned signer              |
| `window.DappFenceConfig`, `data-*` attributes, URL params | **No.** Never read text from these: the page controls them              |

Integrators keep overrides in plain JSON files (one `<locale>.json` per language). manifest-tools
validates them and merges them into the payload **before signing**. See the `messages` option in
[`@dappfence/manifest-tools`](../packages/manifest-tools/README.md#customizing-the-warning-text).

### Resolution

`resolveMessages(languages, overrides)` (`src/messages/index.js`) picks one string per key. It tries
each of the viewer's languages (`navigator.languages`) in order, then that language's base (`es-AR`
→ `es`), then `en`. At each step a verified override wins over the built-in text. Built-in `en`
defines every key, so resolution always succeeds. The viewer's language only chooses _among_ trusted
catalogs, so it's fine that the page can influence it.

-   **Warning page:** the SW resolves text per request, using the `messages` of the latest manifest
    in `trustedManifestStore`. That store only ever holds manifests that passed signature
    verification. If the page shows _because_ a new manifest was rejected (`SIGNER_CHANGED`, …), the
    last trusted one still supplies the text. With none, built-in text is used.
-   **Emergency panel:** it appears after the browser wiped storage, when the SW and manifest may be
    gone. So the SW sends the trusted overrides to each page in reply to `CLIENT_READY`
    (`MSG.MESSAGES`), and `client/emergency-panel.js` keeps them in memory. The client accepts that
    message once, only from a browser-dispatched (`isTrusted`) event, and validates it again. If
    nothing arrived (e.g. a first visit before any manifest loaded), the panel uses built-in text.

Every boundary runs the same `validateMessages`: manifest-tools (fails the build), the SW's manifest
normalization (drops and logs) and the client (drops and logs). It accepts only:

-   locale tags matching `^[a-z]{2,3}(-[a-z0-9]{2,8})*$`;
-   keys defined in `en.json`;
-   string values of at most 500 characters.

## Common tasks

### Change or add text

1. Edit `src/messages/en.json`. A new key goes there first, since `en` is the reference catalog and
   defines the set of allowed keys.
2. Use it as `{{t:key}}` in a template, `t('key')` in the warning page script, or through a view in
   `response.js`. `src/core/__tests__/template.test.js` fails on any key the catalog lacks.

Changing English text is a core release, like any other bundle change.

### Add a built-in language

Add `src/messages/<locale>.json` (lowercase tag, e.g. `pt-br.json`) and register it in
`BUILTIN_CATALOGS` in `src/messages/index.js`. A translation may omit keys, which then fall back to
English, but must not contain keys English doesn't have. `src/messages/__tests__/messages.test.js`
checks this.

### Change a colour or size everywhere

Edit `styles/tokens.css`. Every component reads the token.

### Add a component

1. Create `styles/components/<name>.css` with a header comment listing its classes and variants.
2. Use only `--df-*` tokens; add new tokens to `tokens.css` if needed.
3. `@import '../components/<name>.css';` in each page entry that uses it.
4. Add it to the component table above.

### Add a partial

1. Create `partials/<name>.html`. Use `{{key}}` for anything the including page should supply.
2. Include it: `<!-- @include ../partials/<name>.html key="value" -->`.

A placeholder can have a default, `{{key=value}}`, used when the include doesn't set `key`.

An `.svg` can be included the same way (`<!-- @include ../assets/logo.svg -->`): it's inlined as
markup, minus its `<?xml ?>` declaration and comments. Its `id`s land in the page as-is unless the
include sets `id-prefix="p"`: then every `id` becomes `p-<id>`, and so does every `url(#…)` and
`href="#…"` reference to it. If the same SVG is included again with the same prefix, that copy gets
`p-2`, `p-3`, … in include order, so the output stays reproducible. A page that ends up with a
duplicate `id` fails the build.

`partials/logo.html` uses `id-prefix="{{prefix=df-logo}}"`, so it can be included any number of
times with no arguments. Pass `prefix="…"` only if you want specific ids.

### Add a theme

Add a `.df-theme-<name>` class to `themes.css` that overrides tokens only. A token that only looks
right in one theme (for example a text colour on a tinted box) needs a value in both: `tokens.css`
for light, and both dark blocks in `themes.css`.

### Add a page

1. `pages/<name>.html`, including `partials/head.html` (it carries the `/* @styles */` marker).
2. `styles/pages/<name>.css` that imports `tokens.css`, `base.css` and the components it needs.
3. Render it:

    ```js
    import html from '../templates/pages/<name>.html?template';
    import css from '../templates/styles/pages/<name>.css?inline';
    import { renderTemplate } from '../core/template.js';

    const PAGE_HTML = renderTemplate(html, css);
    ```

4. Add the page to the `PAGES` map in `src/core/__tests__/template.test.js`.
5. Add it to the preview's page registry in `preview/pages.js` (see [Previewing](#previewing)).

## Previewing

`npm run dev:templates` (from the repo root) starts a Vite dev server for the templates at
<http://localhost:5555>. It uses the same pipeline as the build (the include plugin, `?inline` CSS,
`renderTemplate`) and the **real renderers**: the security warning page goes through
`createSecurityPageResponse`, so the titles, labels, summary and grouping come from
`src/sw/response.js`, not from sample data.

Editing any token, component, partial or page reloads the open views automatically, and they come
back on the same view, because every setting lives in the URL.

| URL                                                             | View                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/?width=phone&theme=both`                                      | **Catalog**: every page × scenario as a live thumbnail. Click one to open it.       |
| `/frame.html?page=security-warning&scenario=signer`             | **Full page**: the page as a top-level document, exactly as a visitor sees it       |
| `/frame.html?page=security-warning&scenario=signer&view=source` | **HTML**: the rendered HTML string as text, exactly as the service worker serves it |

-   **Theme:** `auto` (the default) shows the pages as shipped, following this browser's light/dark
    preference; `light` and `dark` force one by adding `df-theme-<theme>` to the page's `<body>`.
    The catalog's toggle sets it for every thumbnail, and every link (full page, HTML) carries it.
    The catalog also has `both` (`/?theme=both`): each scenario as a light and a dark thumbnail side
    by side, each opening the full page in its own theme. Add `&theme=dark` to any full-page URL to
    switch that view directly.
-   **Width:** the catalog renders thumbnails at `desktop` (1280), `tablet` (768) or `phone` (390)
    width. For the full page, resize the window or use DevTools' device toolbar.
-   **HTML:** the "HTML" link under each thumbnail shows the rendered HTML (partials expanded, CSS
    inlined) as text, with a Copy button. The browser's view-source can't show it, because the
    full-page view injects the page with `document.write`. The security warning page builds its
    content in the browser from encoded block data, so to read its final DOM use DevTools → Elements
    on the full page.

The catalog renders each thumbnail inside a sandboxed `<iframe srcdoc>`. The templates reset `*` and
set `:root` variables, so they must not share a document with the catalog's own interface, and the
sandbox (scripts allowed, dialogs not) stops any page from prompting while the catalog navigates.

"Remove Site Lock" works: the Vite server answers `POST /sw-api/site-unblock` with a stub (see the
`template-preview-unblock-stub` plugin in `vite.config.js`). Behaviour that depends on a real
service worker or site (the actual unlock, the emergency panel replacing a live app) still needs
`npm run dev` and the end-to-end tests.

### Files

| File                       | Role                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| `preview/pages.js`         | Page registry: each page's scenarios and a `render(scenario)` function |
| `preview/scenarios.js`     | Raw block records and the security warning scenarios                   |
| `preview/sample-messages/` | Sample integrator overrides (Spanish) for the `overrides` scenarios    |
| `preview/index.html`       | Catalog markup: toolbar and `<template>`s for sections, cards, thumbs  |
| `preview/preview.js`       | Catalog logic: clones the templates and fills their `data-slot`s       |
| `preview/frame.html`       | Full-page shell and the `?view=source` markup                          |
| `preview/frame.js`         | Full-page view                                                         |
| `src/templates/preview/`   | Preview-only templates: logo sheets, base dialog, elements, palette    |

`preview/` is not published (the package's `files` lists only `dist`), and nothing in it reaches a
build. `vite.config.js` defines `__FEATURES__` from `feature_flag.json` for `vite serve` only,
because builds fill it in at the end of the build, which a dev server never reaches.

### Add a scenario

Add an entry to `warningScenarios` in `preview/scenarios.js`: a name mapped to an array of raw block
records, as the service worker stores them (`status`, `reason`, `assetType`, `fileKey`, hashes,
`occurrenceCount`, `timestamp`). Don't add `view` or `formattedTimestamp`: the renderer derives
them. Use `ts(minutesAgo)` for timestamps, so renders stay the same between runs.

The **Logo variants** page (`/frame.html?page=logos`) shows the footer, `partials/logo.html` at
several sizes, the isotype and wordmark on their own, and the resolved `--df-logo-*` palette. Its
`default` scenario follows the theme like any page (use the toggle, or `both` in the catalog); the
`side-by-side` scenario always shows the light and the dark sheet next to each other at full size,
for comparing details. Both live in `src/templates/preview/` because includes can't reach outside
`src/templates/`; only `preview/pages.js` imports them, so they never reach a bundle.

### Add a page to the preview

Add an entry to `PAGES` in `preview/pages.js` with a `title`, its `scenarios` (use
`{ default: null }` for a page without data) and a `render(scenario)` function that returns the
complete HTML document. It appears in the catalog automatically.

## Testing

| Test                                     | Covers                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build/__tests__/html-includes.test.js`  | include expansion, placeholders, SVG id prefixes, indentation, every error case                                                                     |
| `src/core/__tests__/template.test.js`    | each page fully expanded, styles marker present once, CSS bundled with `@import`s inlined, every `<template>` id and `data-slot` used by the script |
| `src/sw/__tests__/response.test.js`      | config placeholder and the view fields the page script reads                                                                                        |
| `packages/test-app/test/**` (Playwright) | the real pages served in the browser                                                                                                                |

Vitest only processes CSS files matching `test.css.include` in `vite.config.js` (set to
`src/templates/`). Without that, `?inline` imports return an empty string in tests.

Run `npm run test:unit` for the unit tests, and `npm run test:e2e` after changing anything the
end-to-end tests depend on (see the page constraints above). For visual changes, check every
scenario in the preview catalog (`npm run dev:templates`) at desktop and phone widths.
