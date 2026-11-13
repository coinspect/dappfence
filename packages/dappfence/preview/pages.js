/**
 * Page registry for the template preview. Each page lists its scenarios and
 * renders one to a complete HTML document through the same code the service
 * worker and client use. Add a page here and it appears in the catalog and
 * toolbar automatically.
 */
import { createSecurityPageResponse } from '../src/sw/response.js';
import { createEmergencyPanel } from '../src/client/emergency-panel.js';
import { resolveMessages, validateMessages } from '../src/messages/index.js';
import { escapeHtml, renderMessages, renderTemplate } from '../src/core/template.js';
import logosHtml from '../src/templates/preview/logos.html?template';
import logosSideBySideHtml from '../src/templates/preview/logos-side-by-side.html?template';
import logosCss from '../src/templates/preview/logos.css?inline';
import baseDialogHtml from '../src/templates/preview/base-dialog.html?template';
import baseDialogCss from '../src/templates/preview/base-dialog.css?inline';
import elementsHtml from '../src/templates/preview/elements.html?template';
import elementsCss from '../src/templates/preview/elements.css?inline';
import paletteHtml from '../src/templates/preview/palette.html?template';
import paletteCss from '../src/templates/preview/palette.css?inline';
import tokensCss from '../src/templates/styles/tokens.css?raw';
import shieldIcon from '../src/templates/assets/icons/shield.svg?raw';
import infoIcon from '../src/templates/assets/icons/info.svg?raw';
import warningIcon from '../src/templates/assets/icons/warning.svg?raw';
import errorIcon from '../src/templates/assets/icons/error.svg?raw';
import { warningScenarios } from './scenarios.js';
import sampleEs from './sample-messages/es.json';

// Integrator overrides as they'd arrive from a verified manifest, run through
// the same validation the SW applies. Shown with a Spanish-speaking viewer;
// keys the sample lacks fall back to built-in English.
const SAMPLE_OVERRIDES = validateMessages({ es: sampleEs }).messages;
const SAMPLE_TEXT = { languages: ['es-AR'], overrides: SAMPLE_OVERRIDES };

/** The icon each base dialog variant shows in its disc. */
const DIALOG_ICONS = { brand: shieldIcon, info: infoIcon, warn: warningIcon, error: errorIcon };

/**
 * base-dialog.html with its colour band switched from --brand to `variant`
 * and the shield in its disc swapped for that variant's icon.
 */
function withDialogVariant(variant) {
    return baseDialogHtml
        .replace('df-card__band--brand', `df-card__band--${variant}`)
        .replace(
            /(<span class="df-card__band-icon">)[\s\S]*?(<\/span>)/,
            (_match, open, close) => `${open}${DIALOG_ICONS[variant]}${close}`
        );
}

/** A token value that is a colour, or another token (which may be one). */
const COLOUR_VALUE = /^(#|rgba?\(|hsla?\(|var\(--df-)/;

/**
 * The colour tokens of tokens.css, grouped by its section comments: a
 * comment on its own line starts a group, named by its first phrase; a
 * comment after a token is that token's note. Non-colour tokens (radius,
 * font) are left out.
 * @param {string} css
 * @returns {{ name: string, tokens: { name: string, note: string }[] }[]}
 */
export function paletteGroups(css) {
    const groups = [];
    const pattern = /\/\*([\s\S]*?)\*\/|(--df-[\w-]+):\s*([^;]+);(?:[ \t]*\/\*([\s\S]*?)\*\/)?/g;
    for (const [, comment, name, value, note] of css.matchAll(pattern)) {
        if (comment !== undefined) {
            const title = comment
                .trim()
                .split(/\.\s|,\s|\s\(|:\s/)[0]
                .replace(/\.$/, '');
            groups.push({ name: title, tokens: [] });
        } else if (groups.length && COLOUR_VALUE.test(value.trim())) {
            groups[groups.length - 1].tokens.push({ name, note: (note ?? '').trim() });
        }
    }
    return groups.filter((group) => group.tokens.length);
}

/** Swatch markup for every colour token in tokens.css. */
function paletteMarkup() {
    return paletteGroups(tokensCss)
        .map(
            (group) => `<section class="df-palette__group">
    <h3>${escapeHtml(group.name)}</h3>
    <ul class="df-swatches">${group.tokens
        .map(
            ({ name, note }) => `
        <li class="df-swatch" data-token="${name}">
            <span class="df-swatch__chip"><span style="background: var(${name})"></span></span>
            <code>${name}</code>
            <span class="df-swatch__value"></span>
            ${note ? `<span class="df-swatch__note">${escapeHtml(note)}</span>` : ''}
        </li>`
        )
        .join('')}
    </ul>
</section>`
        )
        .join('\n');
}

/**
 * @typedef {object} PreviewPage
 * @property {string} title
 * @property {string} [group] - consecutive pages with the same group share
 *   one catalog row, titled by the group, each card naming its page
 * @property {Record<string, unknown>} scenarios - scenario name -> data passed to render
 * @property {(scenario: unknown) => Promise<string>} render - full HTML document
 */

/** @type {Record<string, PreviewPage>} */
export const PAGES = {
    logos: {
        title: 'Logo variants',
        group: 'Design system',
        // Preview-only sheets (src/templates/preview/): every logo variant
        // through the real partials and tokens. `default` follows the theme
        // like any page; `side-by-side` always shows light and dark at full
        // size, for comparing details.
        scenarios: { default: logosHtml, 'side-by-side': logosSideBySideHtml },
        render: async (html) =>
            renderMessages(renderTemplate(html, logosCss), resolveMessages(['en'])),
    },
    palette: {
        title: 'Palette',
        group: 'Design system',
        // Preview-only sheet (src/templates/preview/): every colour token,
        // generated from tokens.css, in light and dark side by side.
        scenarios: { default: paletteHtml },
        render: async (html) =>
            renderTemplate(html.replaceAll('<div data-palette></div>', paletteMarkup), paletteCss),
    },
    elements: {
        title: 'Elements',
        group: 'Design system',
        // Preview-only sheet (src/templates/preview/): the small components
        // in every variant, starting with the buttons.
        scenarios: { default: elementsHtml },
        render: async (html) =>
            renderMessages(renderTemplate(html, elementsCss), resolveMessages(['en'])),
    },
    'base-dialog': {
        title: 'Base dialog',
        // Preview-only (src/templates/preview/): the empty card shell the
        // pages are built on. One scenario per colour band variant of the
        // raised card (base-dialog.html ships with --brand and the shield;
        // the others swap the class and the icon).
        scenarios: {
            brand: baseDialogHtml,
            info: withDialogVariant('info'),
            warn: withDialogVariant('warn'),
            error: withDialogVariant('error'),
        },
        render: async (html) =>
            renderMessages(renderTemplate(html, baseDialogCss), resolveMessages(['en'])),
    },
    'security-warning': {
        title: 'Security warning',
        scenarios: {
            ...warningScenarios,
            overrides: { blocks: warningScenarios.mismatch, text: SAMPLE_TEXT },
        },
        render: (scenario) =>
            Array.isArray(scenario)
                ? createSecurityPageResponse('preview-token', scenario).text()
                : createSecurityPageResponse(
                      'preview-token',
                      scenario.blocks,
                      scenario.text
                  ).text(),
    },
    'emergency-panel': {
        title: 'Emergency panel',
        scenarios: { default: null, overrides: SAMPLE_TEXT },
        // The panel is a <head>/<body> fragment that replaces a live page's
        // documentElement; wrap it so it renders standalone.
        render: async (text) => {
            const messages = text ? resolveMessages(text.languages, text.overrides) : undefined;
            return `<!doctype html><html lang="en">${createEmergencyPanel(messages)}</html>`;
        },
    },
};

export const WIDTHS = { desktop: 1280, tablet: 768, phone: 390 };

/**
 * Theme the preview renders pages in. `auto` leaves the page as shipped, so it
 * follows this browser's light/dark preference; the others force a theme by
 * adding its class to <body>, the same class an integrator would use.
 */
export const THEMES = ['auto', 'light', 'dark'];

/**
 * Read page / scenario / width / theme from a query string, falling back to
 * the first page, its first scenario, desktop width and the auto theme.
 * @param {string} search
 */
export function readSelection(search) {
    const params = new URLSearchParams(search);
    const pageName = params.get('page') in PAGES ? params.get('page') : Object.keys(PAGES)[0];
    const page = PAGES[pageName];
    const scenarioNames = Object.keys(page.scenarios);
    const scenario = scenarioNames.includes(params.get('scenario'))
        ? params.get('scenario')
        : scenarioNames[0];
    const width = params.get('width') in WIDTHS ? params.get('width') : 'desktop';
    const theme = THEMES.includes(params.get('theme')) ? params.get('theme') : 'auto';
    return { pageName, page, scenario, width, theme };
}

/**
 * Query string for a view, leaving out defaults so links stay short.
 * @param {Record<string, string>} params
 */
export function viewQuery(params) {
    const defaults = { width: 'desktop', theme: 'auto' };
    return new URLSearchParams(
        Object.entries(params).filter(([key, value]) => value && value !== defaults[key])
    ).toString();
}

/**
 * Add `df-theme-<theme>` to the rendered page's <body>, unless theme is auto.
 * Only looks after </head>: the inlined CSS mentions `<body>` in comments.
 * @param {string} html
 * @param {string} theme
 */
function applyTheme(html, theme) {
    if (theme === 'auto') {
        return html;
    }
    const themeClass = `df-theme-${theme}`;
    const bodyStart = html.indexOf('</head>') + 1; // 0 when there is no </head>
    const tail = html
        .slice(bodyStart)
        .replace(/<body([^>]*)>/, (_match, attrs) =>
            /\sclass="/.test(attrs)
                ? `<body${attrs.replace(/(\sclass=")/, `$1${themeClass} `)}>`
                : `<body${attrs} class="${themeClass}">`
        );
    return html.slice(0, bodyStart) + tail;
}

/** Render one page/scenario pair to HTML, in the given theme. */
export async function renderScenario(pageName, scenario, theme = 'auto') {
    const page = PAGES[pageName];
    return applyTheme(await page.render(page.scenarios[scenario]), theme);
}
