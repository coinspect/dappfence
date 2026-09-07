import { API } from '../../core/constants.js';

// csp.pages keys are exact paths (e.g. `/dashboard`) or trailing-slash prefixes
// (e.g. `/posts/`) — see docs/csp-collection.md. Exact match wins; otherwise the
// longest prefix that fileKey starts with.
const matchCspPageEntry = (pages, fileKey) => {
    if (!pages) return undefined;
    if (fileKey in pages) return pages[fileKey];
    let match,
        matchLen = -1;
    for (const key of Object.keys(pages)) {
        if (key.length > matchLen && fileKey.startsWith(key)) {
            match = pages[key];
            matchLen = key.length;
        }
    }
    return match;
};

/**
 * Builds the response headers for a CSP-protected navigation.
 *
 * manifest.csp shape (all *Origins fields default to []):
 *   {
 *     connectOrigins:          ["https://api.example.com"],  // extra fetch/XHR/WebSocket hosts
 *     formActionOrigins:       ["https://payments.example"], // extra form POST targets
 *     frameOrigins:            ["https://embeds.example"],   // extra iframe sources
 *     mediaOrigins:            ["https://media.example"],    // extra <audio>/<video> sources
 *     manifestSrcOrigins:      ["https://cdn.example"],      // extra <link rel="manifest"> sources
 *     imgOrigins:              ["https://images.example"],   // extra image sources (CDNs)
 *     fontOrigins:             ["https://fonts.example"],    // extra font sources (e.g., Google Fonts)
 *     styleOrigins:            ["https://styles.example"],   // extra external stylesheet sources
 *     frameAncestors:          ["https://parent.example"],   // parents allowed to embed this page
 *     upgradeInsecureRequests: false,                         // enable auto-upgrade of http:// subresources
 *     reportSample:            true,                           // include 40-char sample of blocked inline in reports
 *     pages: { "/": { scripts: ["sha256-..."], attrs: [...] } }
 *   }
 *
 * Loosening model — every *Origins field is additive to a secure default that already
 * includes `'self'` (plus `data:` for img-src, `'unsafe-inline'` for style-src). The
 * manifest can widen origins but cannot introduce `'unsafe-*'` keywords or `*` wildcards.
 * Directives that are always-locked (`script-*`, `worker-src`, `object-src`, `base-uri`)
 * have no manifest knob because loosening them would undermine the model.
 *
 * Emission rules:
 *   - `form-action` is always emitted (`'self' + formActionOrigins`). It does NOT fall
 *     back to `default-src`, so omitting it would leave form POSTs unrestricted.
 *   - `manifest-src` is always emitted (`'self' + manifestSrcOrigins`) so PWAs work by
 *     default; without it the `default-src 'none'` fallback blocks the web app manifest.
 *   - `frame-src` and `media-src` are emitted ONLY when the manifest declares origins.
 *     Both fall back to `default-src 'none'`, so omitting keeps iframes and media blocked;
 *     emitting `'self'` by default would loosen that.
 *   - `frame-ancestors` defaults to `'none'`; when the manifest declares parents, it emits
 *     `'self' + frameAncestors` so same-origin embedding still works for the app itself.
 *   - `upgrade-insecure-requests` and `csp.reportSample` arrive here as plain booleans;
 *     normalizeManifestData (sw/storage/manifest-store.js) resolves the manifest tri-state
 *     against the `csp_upgrade_insecure_requests` / `csp_report_sample` feature flags. `reportSample`
 *     asks the browser to include up to 40 chars of blocked inline in reports — helpful in
 *     dev, a data-leak risk in prod (hence flag default: dev=true, prod=false).
 *
 * External script sources are allowed via `*` in `script-src-elem` — DappFence already
 * verifies every external script by content hash at the SW level, so there is no security
 * benefit in restricting them by origin in the CSP. Inline scripts are gated by:
 *   - the SW-generated `nonce` (used to tag the trusted bootstrap and any script the SW
 *     verifies at runtime, e.g., RSC push chunks under the planned RSC parser); and
 *   - the build-time `'sha256-...'` hashes listed in `csp.pages[fileKey].scripts`.
 * Matching the nonce OR any listed hash lets an inline script run; the browser
 * blocks anything else.
 *
 * Origin CSP headers (both enforce and report-only) are stripped from the response before
 * the manifest-derived policy is set. The origin is untrusted per
 * docs/csp-injection-strategy.md — appending would leave attacker-controlled directives
 * (frame-ancestors, form-action, report-uri, etc.) binding whenever DappFence doesn't emit
 * them.
 *
 * `'strict-dynamic'` is intentionally omitted. It is incompatible with the `*` wildcard
 * (strict-dynamic ignores all origin allowlists), and the external-script trust that
 * strict-dynamic would otherwise propagate is already covered by SW-level verification.
 *
 * `worker-src 'self'` is required because DappFence registers its own service worker from
 * the page context. `'self'` cannot be tightened to a specific path portably; the browser
 * already enforces that service workers must be same-origin regardless of CSP.
 *
 * @param {string} fileKey - resolved manifest key for the requested page
 * @param {Response} response - origin response; its headers are copied, origin CSP
 *   headers are stripped, and the manifest-derived policy is set
 * @param {object|null|undefined} manifest
 * @param {string|null} [apiToken] - when provided, appended as ?token= on report-uri
 *   so the SW can validate reports and reject unauthenticated POSTs
 * @param {string} nonce - SW-generated per-response nonce, emitted in `script-src-elem`
 *   alongside the build-time-stable hashes and `*`
 * @returns {Headers} composed response headers, ready to apply
 */
export function buildCspHeader(fileKey, response, manifest, apiToken, nonce) {
    const csp = manifest?.csp ?? {};
    const connectOrigins = csp.connectOrigins ?? [];
    const formActionOrigins = csp.formActionOrigins ?? [];
    const frameOrigins = csp.frameOrigins ?? [];
    const mediaOrigins = csp.mediaOrigins ?? [];
    const manifestSrcOrigins = csp.manifestSrcOrigins ?? [];
    const imgOrigins = csp.imgOrigins ?? [];
    const fontOrigins = csp.fontOrigins ?? [];
    const styleOrigins = csp.styleOrigins ?? [];
    const frameAncestors = csp.frameAncestors ?? [];
    // Already resolved by normalizeManifestData — see manifest-store.js.
    const upgradeInsecureRequests = csp.upgradeInsecureRequests === true;
    const sampleParts = csp.reportSample === true ? ["'report-sample'"] : [];

    const pageEntry = matchCspPageEntry(csp.pages, fileKey);
    const scriptHashes = Array.isArray(pageEntry) ? pageEntry : pageEntry?.scripts ?? [];
    const attrHashes = Array.isArray(pageEntry) ? [] : pageEntry?.attrs ?? [];

    // Nonce first so the trusted bootstrap matches; hashes for build-time inline;
    // `*` for external scripts the SW verifies by content hash at fetch time.
    const scriptElemParts = [
        ...sampleParts,
        `'nonce-${nonce}'`,
        ...scriptHashes.map((h) => `'${h}'`),
        '*',
    ];

    // 'unsafe-inline' is safe for styles — CSS JS-execution vectors (expression(),
    // behavior:, HTC) are IE-only. See docs/js-execution-vectors.md §11.
    const styleSrcParts = [...sampleParts, "'self'", "'unsafe-inline'", ...styleOrigins];
    const imgSrcParts = ["'self'", 'data:', ...imgOrigins];
    const fontSrcParts = ["'self'", ...fontOrigins];
    const connectSrcParts = ["'self'", ...connectOrigins];
    const manifestSrcParts = ["'self'", ...manifestSrcOrigins];
    const formActionParts = ["'self'", ...formActionOrigins];
    const frameAncestorsParts =
        frameAncestors.length > 0 ? ["'self'", ...frameAncestors] : ["'none'"];

    const reportUri = apiToken
        ? `${API.CSP_VIOLATION}?token=${encodeURIComponent(apiToken)}`
        : API.CSP_VIOLATION;

    const directives = [
        "default-src 'none'",
        `script-src-elem ${scriptElemParts.join(' ')}`,
        `style-src ${styleSrcParts.join(' ')}`,
        `img-src ${imgSrcParts.join(' ')}`,
        `font-src ${fontSrcParts.join(' ')}`,
        `connect-src ${connectSrcParts.join(' ')}`,
        `manifest-src ${manifestSrcParts.join(' ')}`,
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        `frame-ancestors ${frameAncestorsParts.join(' ')}`,
        `form-action ${formActionParts.join(' ')}`,
    ];

    // script-src-attr is only emitted when on* attribute hashes are declared.
    // the CSP spec requires 'unsafe-hashes' for hashes to apply to event handlers;
    // without it hashes in this directive are silently ignored.
    if (attrHashes.length > 0) {
        const attrParts = [...sampleParts, "'unsafe-hashes'", ...attrHashes.map((h) => `'${h}'`)];
        directives.splice(2, 0, `script-src-attr ${attrParts.join(' ')}`);
    }

    // frame-src and media-src are only emitted when origins are declared; without them,
    // the `default-src 'none'` fallback keeps iframes and <audio>/<video> blocked.
    if (frameOrigins.length > 0) {
        directives.push(`frame-src 'self' ${frameOrigins.join(' ')}`);
    }
    if (mediaOrigins.length > 0) {
        directives.push(`media-src 'self' ${mediaOrigins.join(' ')}`);
    }

    if (upgradeInsecureRequests) {
        directives.push('upgrade-insecure-requests');
    }

    // `report-uri` must stay last so its URL doesn't collide with a following
    // directive when consumers scan for it with a `\S+`-style regex. CSP3 marks
    // it as deprecated in favor of `Reporting-Endpoints` + `report-to`, but no
    // browser has announced a removal timeline and Firefox/Safari still don't
    // ship the Reporting API for CSP — so `report-uri` is currently the only
    // directive that works everywhere. When we do adopt `Reporting-Endpoints`,
    // emit both: Chromium prefers `report-to` when both are present, so no
    // double-reporting.
    directives.push(`report-uri ${reportUri}`);

    // Origin CSP is untrusted — strip both enforce and report-only, then set ours.
    const headers = new Headers(response.headers);
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.set('Content-Security-Policy', directives.join('; '));
    return headers;
}
