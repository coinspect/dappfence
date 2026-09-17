/**
 * Manifest pathRules evaluation.
 */

import { decodePathname } from './verification.js';

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

// Predicate: rule participates in normal key resolution (not an error-page fallback rule).
const isApplicableRule = (pathname) => (r) =>
    r.type !== 'error-page' &&
    (!r.condition?.urlFilter || pathname.startsWith(r.condition.urlFilter));

// Predicate: rule is an error-page fallback matching the response status and request
// destination. The mapped `url` is used as the manifest key downstream — the
// verifier's existing files lookup decides byte-hash vs unknown-key, exactly like
// any normal navigation.
const isErrorPageRule = (pathname, destination, status) => (r) => {
    if (r.type !== 'error-page' || r.status !== status || !r.url) {
        return false;
    }
    const condition = r.condition;
    if (!condition) {
        return true;
    }
    const { urlFilter, resourceTypes } = condition;
    if (urlFilter && !pathname.startsWith(urlFilter)) {
        return false;
    }
    return !(resourceTypes && !resourceTypes.includes(destination));
};

/**
 * Resolve a request URL to its canonical manifest key using pathRules.
 *
 * Same-origin requests → pathname, then pathRules applied in order.
 * Cross-origin requests → full URL (pathRules never apply).
 *
 * A named-type rule succeeds when the resolved candidate exists in `files`.
 * A match/resolveAs rule always succeeds (terminal).
 * When `response` is supplied and non-OK, an `error-page` pathRule can map the
 * pathname to a status-specific URL (last-resort, regardless of rule position).
 * Falls back to pathname if no rule matches.
 *
 * @param {{ url: string, destination: string }} req
 * @param {string} base - SW location href
 * @param {object} manifest - manifest object with pathRules and files
 * @param {{ ok: boolean, status: number }|null} [response] - supply to enable error-page fallback
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
        if (url.startsWith('http')) {
            return url;
        }
        return url.startsWith('/') ? url : '/' + url;
    }

    if (fileUrl.origin !== originUrl.origin) {
        return fileUrl.href;
    }
    const pathname = decodePathname(fileUrl.pathname);
    const fileKey = pathRules
        .filter(isApplicableRule(pathname))
        .map((r) => applyPathRule(r, pathname, files))
        .find(Boolean);
    if (fileKey) {
        return fileKey;
    }

    // error-page is last resort regardless of its position in pathRules.
    if (response && !response.ok && files[pathname] === undefined) {
        const rule = pathRules.find(isErrorPageRule(pathname, req.destination, response.status));
        if (rule) {
            return rule.url;
        }
    }

    return pathname;
};
