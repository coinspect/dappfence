import emergencyPanelHtml from '../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../templates/styles/pages/emergency-panel.css?inline';
import { renderMessages, renderTemplate } from '../core/template.js';
import { resolveMessages, validateMessages } from '../messages/index.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger();

const PANEL_HTML = renderTemplate(emergencyPanelHtml, emergencyPanelCss);

// Text overrides from the latest trusted manifest, sent by the SW at startup
// (MSG.MESSAGES). The panel shows after the browser wiped storage, so they
// must already be in memory by then. Accepted once: a later message can't
// swap the text under a panel that is about to show.
/** @type {Record<string, Record<string, string>>} */
let verifiedOverrides = {};
let overridesAccepted = false;

/**
 * Store the SW's verified overrides for the panel. Only call this with data
 * from a trusted `message` event on navigator.serviceWorker (see
 * security-handler.js) — never with page-supplied config.
 *
 * @param {unknown} raw - `{ [locale]: { [key]: string } }`
 */
export function setMessageOverrides(raw) {
    if (overridesAccepted) {
        logger.warn('Ignoring repeated message overrides');
        return;
    }
    overridesAccepted = true;
    const { messages, errors } = validateMessages(raw);
    for (const error of errors) {
        logger.warn(`Dropping message override (${error})`);
    }
    verifiedOverrides = messages;
}

/** Test hook: forget accepted overrides. */
export function resetMessageOverrides() {
    verifiedOverrides = {};
    overridesAccepted = false;
}

const panelMessages = (win) => resolveMessages(win?.navigator?.languages ?? [], verifiedOverrides);

/**
 * The panel's markup: a `<head>…</head><body>…</body>` fragment.
 *
 * @param {Readonly<Record<string, string>>} [messages] - defaults to the viewer's locale
 */
export function createEmergencyPanel(messages = panelMessages(globalThis)) {
    return renderMessages(PANEL_HTML, messages);
}

/**
 * Replace the current page with the emergency panel, then warn before the
 * user reloads or leaves and block link navigation.
 *
 * The guards are attached here rather than in a `<script>` inside the panel,
 * because scripts inserted through `innerHTML` never run.
 *
 * @param {Window} [win]
 */
export function showEmergencyPanel(win = window) {
    const messages = panelMessages(win);
    const leaveWarning = messages['emergency.leaveWarning'];
    win.document.documentElement.innerHTML = createEmergencyPanel(messages);
    win.addEventListener('beforeunload', (event) => {
        event.preventDefault();
        event.returnValue = leaveWarning;
        return leaveWarning;
    });
    win.addEventListener(
        'click',
        (event) => {
            const target = /** @type {Element | null} */ (event.target);
            if (target?.closest?.('a')) {
                event.preventDefault();
            }
        },
        true
    );
}
