import emergencyPanelHtml from '../templates/pages/emergency-panel.html?template';
import emergencyPanelCss from '../templates/styles/pages/emergency-panel.css?inline';
import { renderTemplate } from '../core/template.js';

const BASE_HTML = renderTemplate(emergencyPanelHtml, emergencyPanelCss);

const SCRIPT_PATTERN = /<script id="dappfence-emergency-script">/;

export function createEmergencyPanel(nonce) {
    if (!nonce) {
        return BASE_HTML;
    }
    return BASE_HTML.replace(SCRIPT_PATTERN, `<script nonce="${nonce}">`);
}
