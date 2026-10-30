# Page Templates — HTML Partials and Modular CSS

How `@dappfence/core` builds the HTML pages it shows to users: the **security warning** page (served
by the service worker when content is blocked) and the **emergency panel** (injected by the client
when the watchdog database is force-closed). Both pages are assembled at build time from shared HTML
partials and shared CSS files, then inlined into the bundle as strings.

Everything lives in `packages/dappfence/src/templates/`. There are no runtime fetches: a page is a
single string with its CSS inside a `<style>` tag, because it must render even when the site itself
can no longer be trusted.

## Layout

```
src/templates/
  pages/                      one file per page; built from partials
    security-warning.html
    emergency-panel.html
  partials/                   HTML fragments shared by pages
    head.html                 <meta> tags, <title>{{title}}, the styles slot
    footer.html               "Protected by DappFence" + timestamp
    block-templates.html      <template> markup for the warning page's block cards
  styles/
    tokens.css                --df-* design tokens (colour, radius, font)
    themes.css                token overrides (.df-theme-dark)
    base.css                  reset and body defaults
    components/               one file per reusable component
      badge.css  block.css  button.css  callout.css  card.css  disclosure.css  info-row.css
    pages/                    one entry stylesheet per page
      security-warning.css
      emergency-panel.css
```

Supporting code:

| File                                               | Role                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/dappfence/build/html-includes.js`        | Vite plugin that expands `<!-- @include -->` (`?template`)                    |
| `packages/dappfence/src/core/template.js`          | `renderTemplate(html, css)`: puts the CSS into the page                       |
| `packages/dappfence/src/sw/response.js`            | Renders the security warning page, adds `DAPPFENCE_CONFIG`                    |
| `packages/dappfence/src/client/emergency-panel.js` | Renders the emergency panel, optionally adds a nonce                          |
| `packages/dappfence/preview/`                      | Template preview app (`npm run dev:templates`), see [Previewing](#previewing) |

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
-   Included content is re-indented to the directive's indentation, so the expanded page stays
    readable when you debug a bundle.
-   Includes can nest.

### Build errors

The plugin stops the build (and fails the tests) when:

| Condition                                      | Error message contains            |
| ---------------------------------------------- | --------------------------------- |
| Included file doesn't exist                    | `cannot read … (included from …)` |
| A file includes itself, directly or indirectly | `include cycle: a -> b -> a`      |
| A path resolves outside `src/templates/`       | `… is outside …`                  |
| A `{{placeholder}}` has no matching attribute  | `no value for {{key}}`            |

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
2. `themes.css` (optional): classes that override tokens. `.df-theme-dark` goes on `<body>`.
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

| File             | Classes                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `card.css`       | `.df-card` (`--raised`, `--alert`), `__header`, `__icon`, `__title`, `__body`, `__footer`, `__branding`, `__timestamp` |
| `button.css`     | `.df-btn`, `--danger`                                                                                                  |
| `badge.css`      | `.df-badge` (`--strong`), `.df-severity-chip`, `.df-chip` (`--service-worker`, `--manifest`)                           |
| `callout.css`    | `.df-callout` (`--warning`, `--danger`), `__title`, `__text`                                                           |
| `disclosure.css` | `.df-disclosure`: put on a `<summary>` to get the rotating ▸ marker                                                    |
| `info-row.css`   | `.df-info-row`, `__label`, `__value`, `__value--hash`                                                                  |
| `block.css`      | `.df-block-list`, `.df-block` (`--group`), `.df-file-list`, `.df-file`                                                 |

## Page-specific constraints

### Security warning (`pages/security-warning.html`)

-   It's a full document (`<!doctype html>`), served by the service worker at
    `/sw-api/security-warning`.
-   Its CSP is `default-src 'unsafe-inline' 'self'`, so CSS and scripts must stay inline. Don't link
    external stylesheets, fonts or images.
-   It must keep the `<script id="dappfence-config">` placeholder. `response.js` slices the page
    around it, and `src/sw/__tests__/response.test.js` checks that it's there.
-   End-to-end tests depend on the title `Security Warning - Content Blocked`, the heading text
    `Security Warning`, and a button named `Remove Site Lock`.

### Emergency panel (`pages/emergency-panel.html`)

-   It's a **fragment** (`<head>…</head><body>…</body>`, no doctype or `<html>`), because it
    replaces `document.documentElement.innerHTML` of an already-loaded page.
-   `<body class="df-theme-dark">` switches it to the dark tokens.
-   An end-to-end test depends on the `<h1>` text `Security Action Required`.
-   **Known issue:** scripts inserted through `innerHTML` never run, so the panel's `onbeforeunload`
    guard and link blocking currently don't work. Fixing this means creating the `<script>` element
    with `document.createElement` instead.

## Common tasks

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

### Add a theme

Add a `.df-theme-<name>` class to `themes.css` that overrides tokens only, import `themes.css` in
the page entry, and put the class on `<body>`.

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
| `/?width=phone`                                                 | **Catalog**: every page × scenario as a live thumbnail. Click one to open it.       |
| `/frame.html?page=security-warning&scenario=signer`             | **Full page**: the page as a top-level document, exactly as a visitor sees it       |
| `/frame.html?page=security-warning&scenario=signer&view=source` | **HTML**: the rendered HTML string as text, exactly as the service worker serves it |

-   **Width:** the catalog renders thumbnails at `desktop` (1280), `tablet` (768) or `phone` (390)
    width. For the full page, resize the window or use DevTools' device toolbar.
-   **HTML:** the "HTML" link under each thumbnail shows the rendered HTML (partials expanded, CSS
    inlined) as text, with a Copy button. The browser's view-source can't show it, because the
    full-page view injects the page with `document.write`. The security warning page builds its
    content in the browser from encoded block data, so to read its final DOM use DevTools → Elements
    on the full page.

The catalog renders each thumbnail inside a sandboxed `<iframe srcdoc>`. The templates reset `*` and
set `:root` variables, so they must not share a document with the catalog's own interface, and the
sandbox (scripts allowed, dialogs not) stops the emergency panel's `beforeunload` prompt from firing
whenever the catalog navigates.

"Remove Site Lock" works: the Vite server answers `POST /sw-api/site-unblock` with a stub (see the
`template-preview-unblock-stub` plugin in `vite.config.js`). Behaviour that depends on a real
service worker or site (the actual unlock, the emergency panel replacing a live app) still needs
`npm run dev` and the end-to-end tests.

### Files

| File                   | Role                                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `preview/pages.js`     | Page registry: each page's scenarios and a `render(scenario)` function |
| `preview/scenarios.js` | Raw block records and the security warning scenarios                   |
| `preview/preview.js`   | Catalog: thumbnails, width toggle, links to the full page and HTML     |
| `preview/frame.js`     | Full-page view                                                         |

`preview/` is not published (the package's `files` lists only `dist`), and nothing in it reaches a
build. `vite.config.js` defines `__FEATURES__` from `feature_flag.json` for `vite serve` only,
because builds fill it in at the end of the build, which a dev server never reaches.

### Add a scenario

Add an entry to `warningScenarios` in `preview/scenarios.js`: a name mapped to an array of raw block
records, as the service worker stores them (`status`, `reason`, `assetType`, `fileKey`, hashes,
`occurrenceCount`, `timestamp`). Don't add `view` or `formattedTimestamp`: the renderer derives
them. Use `ts(minutesAgo)` for timestamps, so renders stay the same between runs.

### Add a page to the preview

Add an entry to `PAGES` in `preview/pages.js` with a `title`, its `scenarios` (use
`{ default: null }` for a page without data) and a `render(scenario)` function that returns the
complete HTML document. It appears in the catalog automatically.

## Testing

| Test                                     | Covers                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build/__tests__/html-includes.test.js`  | include expansion, placeholders, indentation, every error case                                                                                      |
| `src/core/__tests__/template.test.js`    | each page fully expanded, styles marker present once, CSS bundled with `@import`s inlined, every `<template>` id and `data-slot` used by the script |
| `src/sw/__tests__/response.test.js`      | config placeholder and the view fields the page script reads                                                                                        |
| `packages/test-app/test/**` (Playwright) | the real pages served in the browser                                                                                                                |

Vitest only processes CSS files matching `test.css.include` in `vite.config.js` (set to
`src/templates/`). Without that, `?inline` imports return an empty string in tests.

Run `npm run test:unit` for the unit tests, and `npm run test:e2e` after changing anything the
end-to-end tests depend on (see the page constraints above). For visual changes, check every
scenario in the preview catalog (`npm run dev:templates`) at desktop and phone widths.
