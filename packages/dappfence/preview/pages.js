/**
 * Page registry for the template preview. Each page lists its scenarios and
 * renders one to a complete HTML document through the same code the service
 * worker and client use. Add a page here and it appears in the catalog and
 * toolbar automatically.
 */
import { createSecurityPageResponse } from '../src/sw/response.js';
import { createEmergencyPanel } from '../src/client/emergency-panel.js';
import { resolveMessages, validateMessages } from '../src/messages/index.js';
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
};

export const WIDTHS = { desktop: 1280, tablet: 768, phone: 390 };

/**
 * Read page / scenario / width from a query string, falling back to the first
 * page, its first scenario and desktop width.
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
    return { pageName, page, scenario, width };
}

/** Render one page/scenario pair to HTML. */
export function renderScenario(pageName, scenario) {
    const page = PAGES[pageName];
    return page.render(page.scenarios[scenario]);
}
