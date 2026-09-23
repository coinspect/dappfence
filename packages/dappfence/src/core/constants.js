/**
 * Cross-module contract values — strings (and a couple of small frozen
 * objects) that appear in 2+ modules or cross the SW ↔ client boundary.
 * A silent rename in one place breaks coordination, so they live here
 * with one canonical declaration.
 *
 * Scope guard — NOT a home for:
 *   - storage keys (private to each store module)
 *   - magic numbers used in a single place
 *   - UI copy / feature flags
 * Add those where they're used, not here.
 */

// --- `/sw-api/*` endpoints ---

export const API_PREFIX = '/sw-api/';

export const API = {
    STATUS: API_PREFIX + 'status',
    SECURITY_WARNING: API_PREFIX + 'security-warning',
    SITE_UNBLOCK: API_PREFIX + 'site-unblock',
};

// --- postMessage type strings (SW ↔ client) ---

export const MSG = {
    SECURITY_BLOCK: 'DAPPFENCE_SECURITY_BLOCK',
    CLIENT_READY: 'DAPPFENCE_CLIENT_READY',
    CLAIM_CONTROL: 'CLAIM_CONTROL',
};

export const MODE = {
    REPORTING: 'reporting', // log to console and indexeddb
    PROTECTED: 'protected', // stop requests that are invalid
};

/**
 * Verification verdict for a single file or manifest.
 *
 * Each entry is a frozen object carrying both a human-readable `description`
 * (the wire/log/storage form, kept stable for telemetry) and `isViolation`
 * (the action signal — does the caller record + potentially block, or
 * pass through?). Co-locating the classification with the description keeps
 * a single source of truth: adding or reclassifying a status is a one-line
 * change here, no consumer needs to keep an exclusion list current.
 *
 * Comparisons use reference equality (`result.status === VERIFICATION_STATUS.MATCH`).
 * Stringification needs `.description` explicitly — `toString`/`toJSON` would
 * break `structuredClone` (used by IndexedDB), so persistence layers must
 * write `details.status.description`, not the object.
 */
const verdict = (description, isViolation) => Object.freeze({ description, isViolation });

export const VERIFICATION_STATUS = Object.freeze({
    MATCH: verdict('MATCH', false),
    SKIPPED: verdict('SKIPPED', false),
    REWRITE: verdict('REWRITE', false),
    MISMATCH: verdict('MISMATCH', true),
    NOT_FOUND_IN_MANIFEST: verdict('NOT_FOUND_IN_MANIFEST', true),
    UNSUPPORTED_SIGNATURE: verdict('UNSUPPORTED_SIGNATURE', true),
    ERROR: verdict('VERIFICATION_ERROR', true),
    CONFIG_ERROR: verdict('CONFIG_ERROR', true),
});

export const ASSET_TYPE = {
    ASSET: 'asset',
    SERVICE_WORKER: 'service-worker',
    MANIFEST: 'manifest',
};

// Known-inert destinations: responses that the browser never executes as code.
// Unknown future destinations default to executable (fail-closed) — only
// destinations proven safe are listed here.
const INERT_DESTINATIONS = new Set([
    'style',
    'xslt',
    'image',
    'font',
    'track',
    'video',
    'audio',
    'manifest',
    'report',
    'json',
    'text',
    'speculationrules',
]);

export const isExecutableDestination = (destination) =>
    !(INERT_DESTINATIONS.has(destination) || !destination);

// These string values appear verbatim in signed manifests (contentRules actions).
// Changing a value is a breaking change — existing signed manifests would reject.
export const TRANSFORM = Object.freeze({
    NETLIFY_CDP: 'netlify-cdp',
});
