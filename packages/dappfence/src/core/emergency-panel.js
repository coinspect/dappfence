export const EMERGENCY_PANEL_STYLE = `
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .container { max-width: 550px; width: 100%; background: #111827; border: 2px solid #ef4444; border-radius: 12px; padding: 40px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); text-align: center; }
            .icon { font-size: 48px; color: #ef4444; margin-bottom: 20px; }
            h1 { font-size: 24px; color: #ffffff; margin-top: 0; margin-bottom: 16px; font-weight: 700; }
            p { font-size: 15px; line-height: 1.6; color: #9ca3af; margin-bottom: 24px; text-align: left; }
            .alert-box { background: rgba(239, 68, 68, 0.1); border-left: 4px solid #ef4444; padding: 15px; text-align: left; border-radius: 4px; margin-bottom: 30px; }
            .alert-box strong { color: #fca5a5; display: block; margin-bottom: 5px; }
            .support-info { font-weight: 600; color: #3b82f6; background: #1f2937; padding: 12px; border-radius: 6px; letter-spacing: 0.5px; word-break: break-all; }
        `;

export function createEmergencyPanel(nonce) {
    return `
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Critical Security Notice</title>
        <style>${EMERGENCY_PANEL_STYLE}</style>
    </head>
    <body>
        <div class="container">
            <div class="icon">⚠️</div>
            <h1>Security Action Required</h1>
            <p>An authorized system event was intercepted on this machine. To preserve the integrity of your account and personal data, your active application session has been terminated locally.</p>
            <div class="alert-box">
                <strong>CRITICAL INSTRUCTION:</strong> Do NOT refresh this browser window, do NOT attempt to log back in, and do NOT use this website until instructed by our team.
            </div>
            <p>Please contact our verified support channel immediately using an alternative device or secure connection network:</p>
            <div class="support-info">support@://dappfence</div>
        </div>
        <script ${nonce ? 'nonce="' + nonce + '"' : ''}>
            window.onbeforeunload = function () {
                return 'Security event occurred. Are you sure you want to reload?';
            };
            window.addEventListener('click', function (e) {
                if (e.target.tagName === 'A') { e.preventDefault(); }
            }, true);
        </script>
    </body>
    `;
}
