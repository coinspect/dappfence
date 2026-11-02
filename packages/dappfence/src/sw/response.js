// Page template with partials expanded (build/html-includes.js) and its
// stylesheet with @imports inlined (Vite ?inline)
import securityWarningHtml from '../templates/pages/security-warning.html?template';
import securityWarningCss from '../templates/styles/pages/security-warning.css?inline';
import { isFeatureEnabled } from '../core/utils.js';
import { renderMessages, renderTemplate } from '../core/template.js';
import { API, ASSET_TYPE, MSG } from '../core/constants.js';
import { formatMessage, resolveMessages } from '../messages/index.js';

// CSS and the build-time feature flag are static across all renders — fold
// them into the template once at a module load instead of repeating the work
// on every block. `isFeatureEnabled` reads a Vite-defined compile-time
// constant, so it can never change at runtime.
const BASE_HTML = renderTemplate(securityWarningHtml, securityWarningCss);
const AUTO_CONFIRM_SITE_LOCK = isFeatureEnabled('auto_confirm_site_lock');

// Locate the template's placeholder config <script> once at a module load and
// pre-slice the surrounding HTML. Matching by id (not by exact string) means
// prettier / editors can reformat the tag freely without breaking the
// renderer. The presence of the placeholder is pinned by a unit test against the
// bundled template — no need for a runtime check here. The `{{t:key}}` text
// markers depend on the viewer's locale, so they're filled per render.
const CONFIG_SCRIPT_PATTERN = /<script id="dappfence-config">[\s\S]*?<\/script>/;
const { index: configIndex, 0: configMatch } = CONFIG_SCRIPT_PATTERN.exec(BASE_HTML);
const HTML_PREFIX = BASE_HTML.slice(0, configIndex);
const HTML_SUFFIX = BASE_HTML.slice(configIndex + configMatch.length);

/**
 * Per-status / per-reason view copy for the warning page. Mirrors the
 * STATUS_LOG dispatch in sw/storage/index.js (view layer here, log layer
 * there). Entries hold message keys (src/messages/en.json); enrichActiveBlocks
 * resolves them to `{ title, expectedLabel?, actualLabel? }` text. When
 * `expectedLabel` / `actualLabel` are omitted, the template omits the
 * corresponding row — not every reason has hashes or identities to show
 * (e.g. CONFIG_ERROR, DENIED_BY_RULE).
 *
 * @typedef {{ title: string, titleParams?: Record<string, string>, expectedLabel?: string, actualLabel?: string }} BlockViewKeys
 * @typedef {{ title: string, expectedLabel?: string, actualLabel?: string }} BlockView
 */

const HASH_LABELS = {
    expectedLabel: 'block.label.expectedHash',
    actualLabel: 'block.label.actualHash',
};
const SIGNER_LABELS = {
    expectedLabel: 'block.label.pinnedSigner',
    actualLabel: 'block.label.currentSigner',
};

const reasonView = (status, reason) => ({ title: `block.${status}.${reason}` });

/** @type {Record<import('../core/constants.js').ManifestLoadReason, BlockViewKeys>} */
const MANIFEST_UNTRUSTED_VIEWS = {
    SIGNER_CHANGED: { ...reasonView('MANIFEST_UNTRUSTED', 'SIGNER_CHANGED'), ...SIGNER_LABELS },
    SIGNATURE_MISMATCH: {
        ...reasonView('MANIFEST_UNTRUSTED', 'SIGNATURE_MISMATCH'),
        expectedLabel: 'block.label.pinnedSigner',
        actualLabel: 'block.label.recoveredSigner',
    },
    UNSUPPORTED_SIGNATURE: reasonView('MANIFEST_UNTRUSTED', 'UNSUPPORTED_SIGNATURE'),
    SIGNATURE_ERROR: reasonView('MANIFEST_UNTRUSTED', 'SIGNATURE_ERROR'),
    MANIFEST_PARSE_ERROR: reasonView('MANIFEST_UNTRUSTED', 'MANIFEST_PARSE_ERROR'),
    MANIFEST_FETCH_BAD_STATUS: reasonView('MANIFEST_UNTRUSTED', 'MANIFEST_FETCH_BAD_STATUS'),
    MANIFEST_FETCH_EXCEPTION: reasonView('MANIFEST_UNTRUSTED', 'MANIFEST_FETCH_EXCEPTION'),
    CONFIG_ERROR: reasonView('MANIFEST_UNTRUSTED', 'CONFIG_ERROR'),
};

/** @type {Record<import('../core/constants.js').AssetErrorReason, BlockViewKeys>} */
const ERROR_VIEWS = {
    NULL_RESPONSE: reasonView('ERROR', 'NULL_RESPONSE'),
    BODY_UNREADABLE: reasonView('ERROR', 'BODY_UNREADABLE'),
    FETCH_BAD_STATUS: reasonView('ERROR', 'FETCH_BAD_STATUS'),
    FETCH_EXCEPTION: reasonView('ERROR', 'FETCH_EXCEPTION'),
    NO_MANIFEST_AVAILABLE: reasonView('ERROR', 'NO_MANIFEST_AVAILABLE'),
};

/** @type {Record<import('../core/constants.js').FileUntrustedReason, BlockViewKeys>} */
const FILE_UNTRUSTED_VIEWS = {
    HASH_MISMATCH: { ...reasonView('FILE_UNTRUSTED', 'HASH_MISMATCH'), ...HASH_LABELS },
    NOT_IN_MANIFEST: {
        ...reasonView('FILE_UNTRUSTED', 'NOT_IN_MANIFEST'),
        actualLabel: 'block.label.actualHash',
    },
    REDIRECT_NOT_DECLARED: reasonView('FILE_UNTRUSTED', 'REDIRECT_NOT_DECLARED'),
};

const fallbackView = (status, b) => ({
    title: `block.${status}.fallback`,
    titleParams: { reason: b.reason ?? 'unspecified' },
});

/**
 * Dispatch keyed by the status *description* on stored block records.
 * `Record<ViolatingStatusName, …>` enforces full coverage of every
 * violating verdict and rejects any key that isn't a current member —
 * same stale-key guard STATUS_LOG uses, scoped to just the subset of
 * verdicts that produce blocks. Non-violation verdicts never reach the
 * warning page (`recordSecurityViolation` short-circuits before
 * `recordSecurityViolation`), so they're intentionally outside the key set.
 * @type {Record<import('../core/constants.js').ViolatingStatusName, (block: object) => BlockViewKeys>}
 */
const BLOCK_VIEW = {
    FILE_UNTRUSTED: (b) => FILE_UNTRUSTED_VIEWS[b.reason] ?? fallbackView('FILE_UNTRUSTED', b),
    DENIED_BY_RULE: () => ({ title: 'block.DENIED_BY_RULE' }),
    ERROR: (b) => ERROR_VIEWS[b.reason] ?? fallbackView('ERROR', b),
    MANIFEST_UNTRUSTED: (b) =>
        MANIFEST_UNTRUSTED_VIEWS[b.reason] ?? fallbackView('MANIFEST_UNTRUSTED', b),
};

const defaultView = (b) => ({
    title: 'block.default',
    titleParams: { status: b.status ?? 'unknown' },
});

/**
 * @param {BlockViewKeys} keys
 * @param {Readonly<Record<string, string>>} messages
 * @returns {BlockView}
 */
function resolveView({ title, titleParams, expectedLabel, actualLabel }, messages) {
    return {
        title: formatMessage(messages[title], titleParams),
        ...(expectedLabel && { expectedLabel: messages[expectedLabel] }),
        ...(actualLabel && { actualLabel: messages[actualLabel] }),
    };
}

/**
 * Top-of-page summary. Manifest-level blocks get distinct copy because the
 * default "content modified" message is misleading when the failure is
 * signer-rotation or a signature issue — nothing in the page itself has
 * necessarily been tampered with, the trust anchor failed.
 */
function derivePageSummary(blocks, messages) {
    const hasManifestBlock = blocks.some((b) => b.assetType === ASSET_TYPE.MANIFEST);
    if (hasManifestBlock) {
        return {
            subtitle: messages['warning.manifestSubtitle'],
            message: messages['warning.manifestMessage'],
        };
    }
    return {
        subtitle: messages['warning.subtitle'],
        message: messages['warning.message'],
    };
}

function enrichActiveBlocks(blocks, messages) {
    return blocks.map((block) => {
        const view = resolveView((BLOCK_VIEW[block.status] ?? defaultView)(block), messages);
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
 * Creates a 3xx-redirect response with no-cache headers. Use this for every
 * SW-side redirect so behavior (body, cache policy) is consistent.
 * `Response.redirect` is not used because it requires an absolute URL and
 * doesn't let us set additional headers like `Cache-Control`.
 * @param {string} location - The Location header value (relative or absolute)
 * @param {number} [status=302] - 301 / 302 / 303 / 307 / 308
 */
export function createRedirectResponse(location, status = 302) {
    return new Response(null, {
        status,
        headers: {
            Location: location,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
    });
}

/**
 * Build the security warning page response: block details, API token, the
 * build-time feature flag and the page text are baked into the HTML and an
 * inline `DAPPFENCE_CONFIG`. No runtime fetches are needed to populate the
 * page — everything travels in the HTML itself.
 *
 * @param {string|null} apiToken
 * @param {Array} activeBlocks
 * @param {object} [text]
 * @param {readonly string[]} [text.languages] - viewer's preferred locales (navigator.languages)
 * @param {Record<string, Record<string, string>>} [text.overrides] - `messages` of the latest
 *        *trusted* manifest; never anything the page supplied
 */
export function createSecurityPageResponse(
    apiToken,
    activeBlocks,
    { languages = [], overrides } = {}
) {
    const messages = resolveMessages(languages, overrides);
    const enriched = enrichActiveBlocks(activeBlocks, messages);
    const configScript = renderConfigScript({
        apiToken,
        activeBlocks: enriched,
        summary: derivePageSummary(enriched, messages),
        autoConfirmSiteLock: AUTO_CONFIRM_SITE_LOCK,
        reportEventsType: MSG.REPORT_EVENTS,
        reportEventsIntervalMs: __DEV__ ? 15_000 : 300_000,
        messages,
    });
    const html =
        renderMessages(HTML_PREFIX, messages) +
        configScript +
        renderMessages(HTML_SUFFIX, messages);
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
