import emergencyPanelHtml from '../templates/emergency-panel.html?raw';
import emergencyPanelCss from '../templates/emergency-panel.css?raw';

const BASE_HTML = emergencyPanelHtml.replace(
    '/* CSS will be injected here during build */',
    emergencyPanelCss
);

const SCRIPT_PATTERN = /<script id="dappfence-emergency-script">/;

export function createEmergencyPanel(nonce) {
    if (!nonce) {
        return BASE_HTML;
    }
    return BASE_HTML.replace(SCRIPT_PATTERN, `<script nonce="${nonce}">`);
}
