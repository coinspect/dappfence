import emergencyPanelHtml from '../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../templates/styles/pages/emergency-panel.css?inline';
import { renderTemplate } from '../core/template.js';

const PANEL_HTML = renderTemplate(emergencyPanelHtml, emergencyPanelCss);

const LEAVE_WARNING = 'Security event occurred. Are you sure you want to reload?';

/** The panel's markup: a `<head>…</head><body>…</body>` fragment. */
export function createEmergencyPanel() {
    return PANEL_HTML;
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
    win.document.documentElement.innerHTML = PANEL_HTML;
    win.addEventListener('beforeunload', (event) => {
        event.preventDefault();
        event.returnValue = LEAVE_WARNING;
        return LEAVE_WARNING;
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
