/**
 * Manifest rules evaluation: pathRules resolution, contentRules matching,
 * content transforms, and file hash verification.
 */

// ── contentRules ─────────────────────────────────────────────────────────────

/**
 * @param {object|undefined} condition
 * @param {string} fileKey
 * @param {string|undefined} destination
 * @returns {boolean}
 */
export const matchesCondition = (condition, fileKey, destination) => {
    if (!condition) {
        return true;
    }
    const { urlFilter, resourceTypes } = condition;
    if (urlFilter && !fileKey.startsWith(urlFilter)) {
        return false;
    }
    return !(resourceTypes && !resourceTypes.includes(destination));
};

/**
 * @param {string} fileKey
 * @param {string|undefined} destination
 * @param {Array} contentRules
 * @returns {Array}
 */
export const collectContentRuleActions = (fileKey, destination, contentRules = []) =>
    contentRules
        .filter(({ condition }) => matchesCondition(condition, fileKey, destination))
        .map(({ action }) => action);

// ── pathRules ─────────────────────────────────────────────────────────────────

/**
 * Apply a single named pathRule type to a pathname and return the candidate key,
 * or null if the rule does not succeed (candidate not in files).
 *
 * @param {object} rule
 * @param {string} pathname
 * @param {object} files - manifest files map
 * @returns {string|null}
 */
const applyPathRule = (rule, pathname, files) => {
    if (rule.match && rule.resolveAs) {
        return pathname === rule.match ? rule.resolveAs : null;
    }

    const lastSegment = pathname.split('/').pop();
    const hasExtension = lastSegment.includes('.');

    if (rule.type === 'directory-index') {
        if (hasExtension) {
            return null;
        }
        const base = pathname.endsWith('/') ? pathname : pathname + '/';
        const candidate = base + 'index.html';
        return files[candidate] !== undefined ? candidate : null;
    }

    if (rule.type === 'html-extension') {
        if (hasExtension || pathname.endsWith('/')) {
            return null;
        }
        const candidate = pathname + '.html';
        return files[candidate] !== undefined ? candidate : null;
    }

    return null;
};

// Predicate: rule participates in normal key resolution (not a not-found fallback rule).
const isApplicableRule = (pathname) => (r) =>
    r.type !== 'not-found' &&
    (!r.condition?.urlFilter || pathname.startsWith(r.condition.urlFilter));

// Predicate: rule is a not-found fallback whose fallback key exists in files and whose
// condition matches the current request. Used as pathRules.find(isNotFoundRule(...)).
const isNotFoundRule = (pathname, destination, files) => (r) =>
    r.type === 'not-found' &&
    r.fallback &&
    files[r.fallback] !== undefined &&
    matchesCondition(r.condition, pathname, destination);

/**
 * Resolve a request URL to its canonical manifest key using pathRules.
 *
 * Same-origin requests → pathname, then pathRules applied in order.
 * Cross-origin requests → full URL (pathRules never apply).
 *
 * A named-type rule succeeds when the resolved candidate exists in `files`.
 * A match/resolveAs rule always succeeds (terminal).
 * When `response` is supplied and non-OK, a `not-found` pathRule can map the
 * pathname to a fallback key (last-resort, regardless of rule position).
 * Falls back to pathname if no rule matches.
 *
 * @param {{ url: string, destination: string }} req
 * @param {string} base - SW location href
 * @param {object} manifest - manifest object with pathRules and files
 * @param {{ ok: boolean }|null} [response] - supply to enable not-found fallback
 * @returns {string}
 */
export const resolveManifestKey = (req, base, manifest = {}, response = null) => {
    const { pathRules = [], files = {} } = manifest;
    const { url } = req;

    let fileUrl, originUrl;
    try {
        fileUrl = new URL(url, base);
        originUrl = new URL(base);
    } catch (_error) {
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }

    if (fileUrl.origin !== originUrl.origin) {
        return fileUrl.href;
    }

    const { pathname } = fileUrl;

    const fileKey = pathRules
        .filter(isApplicableRule(pathname))
        .map((r) => applyPathRule(r, pathname, files))
        .find(Boolean);
    if (fileKey) {
        return fileKey;
    }

    // not-found is last resort regardless of its position in pathRules
    if (response && !response.ok && files[pathname] === undefined) {
        const rule = pathRules.find(isNotFoundRule(pathname, req.destination, files));
        if (rule) return rule.fallback;
    }

    return pathname;
};

/**
 * Returns true when a manifest contentRule with action `allow` matches the
 * request — used to short-circuit CORS upgrade and verification.
 *
 * @param {{ url: string, destination: string }} req
 * @param {string} locationHref - SW location href (for origin comparison)
 * @param {object|null|undefined} manifest
 * @returns {boolean}
 */
export const isRequestAllowed = (req, locationHref, manifest) => {
    if (!manifest) return false;
    const key = resolveManifestKey(req, locationHref, manifest);
    return collectContentRuleActions(key, req.destination, manifest.contentRules).some(
        (a) => a.type === 'allow'
    );
};
