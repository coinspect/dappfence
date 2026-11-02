import emergencyPanelHtml from '../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../templates/styles/pages/emergency-panel.css?inline';
import { renderMessages, renderTemplate } from '../core/template.js';
import { resolveMessages } from '../messages/index.js';

const PANEL_HTML = renderTemplate(emergencyPanelHtml, emergencyPanelCss);

const panelMessages = (win) => resolveMessages(win?.navigator?.languages ?? []);

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
