/**
 * Page registry for the template preview. Each page lists its scenarios and
 * renders one to a complete HTML document through the same code the service
 * worker and client use. Add a page here and it appears in the catalog and
 * toolbar automatically.
 */
import { createSecurityPageResponse } from '../src/sw/response.js';
import { createEmergencyPanel } from '../src/client/emergency-panel.js';
import { resolveMessages, validateMessages } from '../src/messages/index.js';
import { renderMessages, renderTemplate } from '../src/core/template.js';
import logosHtml from '../src/templates/preview/logos.html?template';
import logosCss from '../src/templates/preview/logos.css?inline';
import { warningScenarios } from './scenarios.js';
import sampleEs from './sample-messages/es.json';

// Integrator overrides as they'd arrive from a verified manifest, run through
// the same validation the SW applies. Shown with a Spanish-speaking viewer;
// keys the sample lacks fall back to built-in English.
const SAMPLE_OVERRIDES = validateMessages({ es: sampleEs }).messages;
const SAMPLE_TEXT = { languages: ['es-AR'], overrides: SAMPLE_OVERRIDES };

/**
 * @typedef {object} PreviewPage
 * @property {string} title
 * @property {Record<string, unknown>} scenarios - scenario name -> data passed to render
 * @property {(scenario: unknown) => Promise<string>} render - full HTML document
 */

/** @type {Record<string, PreviewPage>} */
export const PAGES = {
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
    logos: {
        title: 'Logo variants',
        scenarios: { default: null },
        // Preview-only sheet (src/templates/preview/): every logo variant in
        // the light and dark theme, through the real partials and tokens.
        render: async () =>
            renderMessages(renderTemplate(logosHtml, logosCss), resolveMessages(['en'])),
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
