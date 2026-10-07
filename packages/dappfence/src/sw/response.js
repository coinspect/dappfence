// Import security warning templates using Vite's raw imports
import securityWarningHtml from '../templates/security-warning.html?raw';
import securityWarningCss from '../templates/security-warning.css?raw';
import { isFeatureEnabled } from '../core/utils.js';
import { API, ASSET_TYPE } from '../core/constants.js';

// CSS and the build-time feature flag are static across all renders — fold
// them into the template once at a module load instead of repeating the work
// on every block. `isFeatureEnabled` reads a Vite-defined compile-time
// constant, so it can never change at runtime.
const BASE_HTML = securityWarningHtml.replace(
    '/* CSS will be injected here during build */',
    securityWarningCss
);
const AUTO_CONFIRM_SITE_LOCK = isFeatureEnabled('auto_confirm_site_lock');

// Locate the template's placeholder config <script> once at a module load and
// pre-slice the surrounding HTML. Matching by id (not by exact string) means
// prettier / editors can reformat the tag freely without breaking the
// renderer. The presence of the placeholder is pinned by a unit test against the
// bundled template — no need for a runtime check here.
const CONFIG_SCRIPT_PATTERN = /<script id="dappfence-config">[\s\S]*?<\/script>/;
const { index: configIndex, 0: configMatch } = CONFIG_SCRIPT_PATTERN.exec(BASE_HTML);
const HTML_PREFIX = BASE_HTML.slice(0, configIndex);
const HTML_SUFFIX = BASE_HTML.slice(configIndex + configMatch.length);

/**
 * Emit the `<script>` tag that defines `DAPPFENCE_CONFIG`. The server swaps
 * the template's default `<script id="dappfence-config">…</script>` block for
 * this one. Uses `encodeURIComponent` + a double-quoted string literal.
 * Double quotes are load-bearing: `'` is in `encodeURIComponent`'s unreserved
 * set, so wrapping in single quotes would let an attacker-supplied apostrophe
 * close the literal.
 */
function renderConfigScript(config) {
    const encoded = encodeURIComponent(JSON.stringify(config));
    return `<script>const DAPPFENCE_CONFIG = JSON.parse(decodeURIComponent("${encoded}"));</script>`;
}

/**
 * Per-status / per-reason view copy for the warning page. Mirrors the
 * STATUS_LOG dispatch in sw/storage/index.js (view layer here, log layer
 * there). A view entry resolves to `{ title, expectedLabel?, actualLabel? }`.
 * When `expectedLabel` / `actualLabel` are omitted, the template omits the
 * corresponding row — not every reason has hashes or identities to show
 * (e.g. CONFIG_ERROR, DENIED_BY_RULE).
 *
 * @typedef {{ title: string, expectedLabel?: string, actualLabel?: string }} BlockView
 */

const HASH_LABELS = { expectedLabel: 'Expected hash', actualLabel: 'Actual hash' };
const SIGNER_LABELS = { expectedLabel: 'Pinned signer', actualLabel: 'Current signer' };

const MANIFEST_UNTRUSTED_VIEWS = {
    SIGNER_CHANGED: { title: 'Manifest signer changed since pinning', ...SIGNER_LABELS },
    SIGNATURE_MISMATCH: {
        title: 'Manifest signature identity does not match pinned signer',
        expectedLabel: 'Pinned signer',
        actualLabel: 'Recovered signer',
    },
    UNSUPPORTED_SIGNATURE: { title: 'Manifest signature uses an unsupported algorithm' },
    SIGNATURE_ERROR: { title: 'Manifest signature verification threw an error' },
    MANIFEST_PARSE_ERROR: { title: 'Manifest could not be parsed' },
    MANIFEST_FETCH_BAD_STATUS: { title: 'Manifest fetch returned a non-OK status' },
    MANIFEST_FETCH_EXCEPTION: { title: 'Manifest fetch threw an exception' },
    CONFIG_ERROR: { title: 'DappFence manifest is misconfigured' },
};

const ERROR_VIEWS = {
    NULL_RESPONSE: { title: 'Verification failed: no response received' },
    BODY_UNREADABLE: { title: 'Verification failed: response body unreadable' },
    FETCH_BAD_STATUS: { title: 'Verification failed: non-OK HTTP status' },
    FETCH_EXCEPTION: { title: 'Verification failed: fetch threw' },
    NO_MANIFEST_AVAILABLE: { title: 'Verification failed: no trusted manifest available' },
};

/** @type {Record<string, (block: object) => BlockView>} */
const BLOCK_VIEW = {
    MISMATCH: () => ({ title: 'File content tampered', ...HASH_LABELS }),
    NOT_FOUND_IN_MANIFEST: () => ({
        title: 'File not listed in trusted manifest',
        actualLabel: 'Actual hash',
    }),
    DENIED_BY_RULE: () => ({ title: 'File blocked by security rule' }),
    ERROR: (b) =>
        ERROR_VIEWS[b.reason] ?? { title: `Verification error (${b.reason ?? 'unspecified'})` },
    MANIFEST_UNTRUSTED: (b) =>
        MANIFEST_UNTRUSTED_VIEWS[b.reason] ?? {
            title: `Manifest cannot be trusted (${b.reason ?? 'unspecified'})`,
        },
};

const defaultView = (b) => ({ title: `Security violation (${b.status ?? 'unknown'})` });

/**
 * Top-of-page summary. Manifest-level blocks get distinct copy because the
 * default "content modified" message is misleading when the failure is
 * signer-rotation or a signature issue — nothing in the page itself has
 * necessarily been tampered with, the trust anchor failed.
 */
function derivePageSummary(blocks) {
    const hasManifestBlock = blocks.some((b) => b.assetType === ASSET_TYPE.MANIFEST);
    if (hasManifestBlock) {
        return {
            subtitle: 'Manifest Trust Issue',
            message:
                "DappFence could not establish the authenticity of this site's manifest. " +
                'This can indicate a signer change, a signature mismatch, or a manifest ' +
                'configuration problem. Loading the site may expose you to untrusted content.',
        };
    }
    return {
        subtitle: 'Potentially Malicious Content Blocked',
        message:
            'DappFence has detected that content on this page has been modified and may be unsafe. ' +
            'This protection prevents potentially malicious code from running in your browser.',
    };
}

function enrichActiveBlocks(blocks) {
    return blocks.map((block) => {
        const view = (BLOCK_VIEW[block.status] ?? defaultView)(block);
        return {
            ...block,
            view,
            expectedHashes: block.expectedHashes || [],
            actualHash: block.actualHash || null,
            occurrenceCount: block.occurrenceCount || 1,
            formattedTimestamp: new Date(block.timestamp).toLocaleString(),
        };
    });
}

/**
 * Creates a Response object with the specified parameters
 */
function createResponse(body, status, headers) {
    return new Response(body, {
        status,
        headers,
    });
}

/**
 * Create a security warning response for blocked content
 * Uses redirects for non-HTML requests, direct HTML for navigation
 */
function createSecurityWarningResponse() {
    return createResponse('Security violation detected. File blocked by DappFence.', 403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
}

/**
 * Create security redirect response for blocked content
 * When the security violation is detected in dappfence.js, we need to use client-side JavaScript
 * redirect instead of standard message-based redirection since the client js won't be loaded.
 * This returns a minimal JavaScript snippet that safely redirects to the security warning page.
 */
function createJavascriptRedirectResponse() {
    const body = `window.location.replace("${API.SECURITY_WARNING}")`;
    return createResponse(body, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none';",
    });
}

/**
 * True when the request targets the service worker's own script (same origin
 * and same pathname). Used to choose a JS-redirect response, since the
 * client-side dappfence.js isn't available to handle a postMessage redirect
 * when it is the blocked asset itself.
 */
const isServiceWorkerPath = (requestUrl, locationHref) => {
    try {
        const req = new URL(requestUrl, locationHref);
        const sw = new URL(locationHref);
        return req.origin === sw.origin && req.pathname === sw.pathname;
    } catch (_error) {
        console.error('[response] unexpected error parsing URLs:', requestUrl, locationHref);
    }
    return false;
};

/**
 * Creates an appropriate block response based on context.
 *
 * @param {Request} request - The blocked request
 * @param {string} locationHref - The service worker's location.href
 */
export function createBlockResponse(request, locationHref) {
    if (request.mode === 'navigate') {
        return createRedirectResponse(API.SECURITY_WARNING);
    }
    if (isServiceWorkerPath(request.url, locationHref)) {
        return createJavascriptRedirectResponse();
    }
    return createSecurityWarningResponse();
}

/**
 * Creates a safe empty stub response for rewritten CDN sub resources.
 * The body is a valid JS/CSS comment, so it parses without errors in any context.
 * @param response
 */
export function createRewriteResponse(response) {
    const contentType =
        response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    return new Response('/* replaced by dappfence */', {
        headers: { 'content-type': contentType, 'Cache-Control': 'no-store' },
    });
}

/**
 * Returns a new Response with the given headers applied wholesale.
 *
 * Callers (currently the verifier's CSP handler) are responsible for building
 * the complete Headers instance — that's where the trust-model decisions live
 * (which origin headers to strip, which to preserve, which SW-derived headers
 * to set). See `manifest/csp.js` § `buildCspHeader` and
 * `docs/csp-injection-strategy.md`.
 *
 * @param {Response} response
 * @param {Headers | Record<string, string>} headers
 * @returns {Response}
 */
export function injectResponseHeaders(response, headers) {
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

/**
 * Creates a 302-redirect response with no-cache headers. Use this for every
 * SW-side redirect so behavior (body, cache policy) is consistent.
 * `Response.redirect` is not used because it requires an absolute URL and
 * doesn't let us set additional headers like `Cache-Control`.
 * @param {string} location - The Location header value (relative or absolute)
 */
export function createRedirectResponse(location) {
    return new Response(null, {
        status: 302,
        headers: {
            Location: location,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
    });
}

/**
 * Build the security warning page response: block details, API token, and the
 * build-time feature flag are baked into an inline `DAPPFENCE_CONFIG`. No
 * runtime fetches are needed to populate the page — everything travels in the
 * HTML itself.
 *
 * @param {string|null} apiToken
 * @param {Array} activeBlocks
 */
export function createSecurityPageResponse(apiToken, activeBlocks) {
    const enriched = enrichActiveBlocks(activeBlocks);
    const configScript = renderConfigScript({
        apiToken,
        activeBlocks: enriched,
        summary: derivePageSummary(enriched),
        autoConfirmSiteLock: AUTO_CONFIRM_SITE_LOCK,
    });
    const html = HTML_PREFIX + configScript + HTML_SUFFIX;
    return new Response(html, {
        status: 200,
        statusText: 'Security Warning',
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy':
                "default-src 'unsafe-inline' 'self'; object-src 'none'; base-uri 'none';",
        },
    });
}
