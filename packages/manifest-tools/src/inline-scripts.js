'use strict';

const { promises: fs } = require('fs');
const { calculateStringHash } = require('./build');

// Find `<script` (7 chars) followed by whitespace, >, or / — case-insensitive.
// Returns the index of `<`, or -1.
function indexOfOpenScript(html, from) {
    let i = from;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) return -1;
        const after = html[lt + 7];
        if (
            html.slice(lt, lt + 7).toLowerCase() === '<script' &&
            (after === undefined || /[\s>/]/.test(after))
        ) {
            return lt;
        }
        i = lt + 1;
    }
    return -1;
}

// Find `</script` (8 chars) followed by whitespace or > — case-insensitive.
// Returns the index of `<`, or -1.
function indexOfEndScript(html, from) {
    let i = from;
    while (i < html.length) {
        const lt = html.indexOf('</', i);
        if (lt === -1) return -1;
        const after = html[lt + 8];
        if (
            html.slice(lt, lt + 8).toLowerCase() === '</script' &&
            (after === undefined || /[\s>]/.test(after))
        ) {
            return lt;
        }
        i = lt + 2;
    }
    return -1;
}

// Find the `>` that closes a tag starting at `from`.
function findTagClose(html, from) {
    const idx = html.indexOf('>', from);
    return idx === -1 ? html.length - 1 : idx;
}

// Parse `<script` attributes starting at `attrStart` (the index right after `<script`).
// Returns { hasSrc, hasNonce, contentStart } where contentStart is the first char after '>'.
function parseScriptTag(html, attrStart) {
    let i = attrStart;
    let hasSrc = false;
    let hasNonce = false;
    let type = null;
    while (i < html.length) {
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '>') return { hasSrc, hasNonce, type, contentStart: i + 1 };
        if (html[i] === '/') {
            i++;
            continue;
        }
        if (i >= html.length) break;
        const nameStart = i;
        while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
        const attrName = html.slice(nameStart, i).toLowerCase();
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '=') {
            i++;
            while (i < html.length && /\s/.test(html[i])) i++;
            if (html[i] === '"' || html[i] === "'") {
                const q = html[i++];
                const end = html.indexOf(q, i);
                if (end === -1) return { hasSrc, hasNonce, type, contentStart: html.length };
                if (attrName === 'src') hasSrc = true;
                if (attrName === 'nonce') hasNonce = true;
                if (attrName === 'type') type = html.slice(i, end).trim().toLowerCase();
                i = end + 1;
            } else {
                const valStart = i;
                while (i < html.length && !/[\s>]/.test(html[i])) i++;
                if (attrName === 'src') hasSrc = true;
                if (attrName === 'nonce') hasNonce = true;
                if (attrName === 'type') type = html.slice(valStart, i).trim().toLowerCase();
            }
        } else {
            // Boolean attribute (no value) — nonce requires a value, so only src matters here.
            if (attrName === 'src') hasSrc = true;
        }
    }
    return { hasSrc, hasNonce, type, contentStart: html.length };
}

// Script `type` values the browser NEVER executes — treated as data blocks per HTML spec.
// CSP script-src does not gate these either, so hashing them just puffs the header AND
// (for ISR / dynamic pages) produces stale hashes on every render. Conservative whitelist:
// only the two well-established inert MIMEs. Unknown types keep getting hashed (safe default —
// a future executable type would still be gated).
const NON_EXECUTABLE_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json']);

// HTML5 script data state machine to find the closing `</script>`.
// States: NORMAL (script data), ESCAPED (after <!--), DOUBLE_ESCAPED (after <!--<script).
// In DOUBLE_ESCAPED state, `</script>` transitions back to ESCAPED — it does NOT end the element.
// Returns the index of `<` in the closing `</script>`, or -1 if unterminated.
function findScriptContentEnd(html, from) {
    const NORMAL = 0,
        ESCAPED = 1,
        DOUBLE_ESCAPED = 2;
    let state = NORMAL;
    let i = from;

    while (i < html.length) {
        if (state === NORMAL) {
            const commentOpen = html.indexOf('<!--', i);
            const endScript = indexOfEndScript(html, i);
            if (endScript === -1) return -1;
            if (commentOpen !== -1 && commentOpen < endScript) {
                state = ESCAPED;
                i = commentOpen + 4;
            } else {
                return endScript;
            }
        } else if (state === ESCAPED) {
            const commentClose = html.indexOf('-->', i);
            const scriptOpen = indexOfOpenScript(html, i);
            const endScript = indexOfEndScript(html, i);
            const cc = commentClose !== -1 ? commentClose : Infinity;
            const so = scriptOpen !== -1 ? scriptOpen : Infinity;
            const es = endScript !== -1 ? endScript : Infinity;
            const min = Math.min(cc, so, es);
            if (min === Infinity) return -1;
            if (es === min) return endScript;
            if (cc === min) {
                state = NORMAL;
                i = commentClose + 3;
            } else {
                state = DOUBLE_ESCAPED;
                i = findTagClose(html, scriptOpen) + 1;
            }
        } else {
            // DOUBLE_ESCAPED: </script> goes back to escaped, does not end the element
            const commentClose = html.indexOf('-->', i);
            const endScript = indexOfEndScript(html, i);
            const cc = commentClose !== -1 ? commentClose : Infinity;
            const es = endScript !== -1 ? endScript : Infinity;
            if (Math.min(cc, es) === Infinity) return -1;
            if (cc <= es) {
                state = ESCAPED;
                i = commentClose + 3;
            } else {
                state = ESCAPED;
                i = findTagClose(html, endScript) + 1;
            }
        }
    }
    return -1;
}

// Collect on* attribute {name, value} pairs from a tag starting at attrStart (after the tag name).
// Returns { pairs: [{name, value}], end: index after '>' }.
function parseOnAttrs(html, attrStart) {
    const pairs = [];
    let i = attrStart;
    while (i < html.length) {
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '>') return { pairs, end: i + 1 };
        if (html[i] === '/') {
            i++;
            continue;
        }
        if (i >= html.length) break;

        const nameStart = i;
        while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
        const attrName = html.slice(nameStart, i).toLowerCase();

        while (i < html.length && /\s/.test(html[i])) i++;

        let attrValue = null;
        if (html[i] === '=') {
            i++;
            while (i < html.length && /\s/.test(html[i])) i++;
            if (html[i] === '"' || html[i] === "'") {
                const q = html[i++];
                const end = html.indexOf(q, i);
                if (end === -1) return { pairs, end: html.length };
                attrValue = html.slice(i, end);
                i = end + 1;
            } else {
                const valStart = i;
                while (i < html.length && !/[\s>]/.test(html[i])) i++;
                attrValue = html.slice(valStart, i);
            }
        }

        if (/^on[a-z]/.test(attrName) && attrValue !== null) {
            pairs.push({ name: attrName, value: attrValue });
        }
    }
    return { pairs, end: i };
}

// Core logic: extract inline script body hashes from an HTML string.
function _hashScripts(html) {
    const hashes = [];
    const warnings = [];
    let pos = 0;

    while (pos < html.length) {
        const tagStart = indexOfOpenScript(html, pos);
        if (tagStart === -1) break;

        const { hasSrc, hasNonce, type, contentStart } = parseScriptTag(html, tagStart + 7);
        if (hasSrc) {
            pos = contentStart;
            continue;
        }

        const contentEnd = findScriptContentEnd(html, contentStart);
        if (contentEnd === -1) {
            warnings.push(`Unterminated <script> at offset ${tagStart}`);
            break;
        }

        if (type && NON_EXECUTABLE_SCRIPT_TYPES.has(type)) {
            pos = findTagClose(html, contentEnd + 8) + 1;
            continue;
        }

        if (hasNonce) {
            warnings.push(
                `Inline script at offset ${tagStart} has a nonce attribute. ` +
                    'The script body hash is computed from the static content and is valid, but the server ' +
                    'is using nonce-based CSP. If the script body embeds the nonce value or any other ' +
                    'per-request data, this hash will not be stable across renders.'
            );
        }

        hashes.push(calculateStringHash(html.slice(contentStart, contentEnd)));
        pos = findTagClose(html, contentEnd + 8) + 1;
    }

    return { hashes, warnings };
}

/**
 * Extract SHA-256 hashes of all inline <script> bodies in an HTML file.
 * Uses the HTML5 script data state machine to correctly handle `<!--<script>` double-escape
 * patterns where an intermediate `</script>` does not close the element.
 *
 * @param {string} htmlPath - absolute path to an HTML file
 * @returns {Promise<{ hashes: string[], warnings: string[] }>}
 *   hashes: 'sha256-<base64>' strings, one per inline <script> body
 *   warnings: non-fatal issues found during parsing
 */
async function extractInlineScriptHashes(htmlPath) {
    const raw = await fs.readFile(htmlPath);

    if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
        throw new Error(`${htmlPath}: UTF-16 BOM detected; only UTF-8 is supported`);
    }
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
    const html = raw.slice(bom).toString('utf8');

    const metaMatch = html.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s;>]+)/i);
    if (metaMatch && !/^utf-?8$/i.test(metaMatch[1])) {
        throw new Error(`${htmlPath}: unsupported charset ${metaMatch[1]}`);
    }

    return _hashScripts(html);
}

// Core logic: extract on* attribute hashes from an HTML string.
function _hashAttrs(html) {
    const attrs = [];
    const seen = new Set();
    const warnings = [];
    let i = 0;

    while (i < html.length) {
        if (html.slice(i, i + 4) === '<!--') {
            const end = html.indexOf('-->', i + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }

        if (html[i] !== '<') {
            i++;
            continue;
        }

        if (
            html.slice(i, i + 7).toLowerCase() === '<script' &&
            (html[i + 7] === undefined || /[\s>/]/.test(html[i + 7]))
        ) {
            const { contentStart } = parseScriptTag(html, i + 7);
            const contentEnd = findScriptContentEnd(html, contentStart);
            if (contentEnd === -1) {
                warnings.push(`Unterminated <script> at offset ${i}`);
                break;
            }
            i = findTagClose(html, contentEnd + 8) + 1;
            continue;
        }

        if (html.slice(i, i + 6).toLowerCase() === '<style' && /[\s>/]/.test(html[i + 6] ?? '>')) {
            const closeStyle = html.toLowerCase().indexOf('</style', i + 6);
            if (closeStyle === -1) break;
            i = findTagClose(html, closeStyle) + 1;
            continue;
        }

        if (html[i + 1] && /[a-zA-Z]/.test(html[i + 1])) {
            let j = i + 1;
            while (j < html.length && !/[\s>/]/.test(html[j])) j++;
            const { pairs, end } = parseOnAttrs(html, j);
            i = end;
            for (const { name, value } of pairs) {
                if (!seen.has(value)) {
                    seen.add(value);
                    attrs.push({ name, value, hash: calculateStringHash(value) });
                }
            }
            continue;
        }

        i++;
    }

    return { attrs, warnings };
}

/**
 * Extract SHA-256 hashes of all on* event handler attribute values in an HTML file.
 * Scans outside <script> and <style> blocks and HTML comments.
 * Deduplicates by exact attribute value — identical handlers on multiple elements produce
 * one hash. Returns rich records so the caller can log names/values and let the developer
 * decide which hashes to include in the manifest.
 *
 * @param {string} htmlPath - absolute path to an HTML file
 * @returns {Promise<{ attrs: Array<{name:string, value:string, hash:string}>, warnings: string[] }>}
 *   attrs: one entry per unique attribute value, in discovery order
 *   hash: 'sha256-<base64>' (same format as extractInlineScriptHashes)
 */
async function extractInlineAttrHashes(htmlPath) {
    const raw = await fs.readFile(htmlPath);

    if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
        throw new Error(`${htmlPath}: UTF-16 BOM detected; only UTF-8 is supported`);
    }
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
    const html = raw.slice(bom).toString('utf8');

    const metaMatch = html.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s;>]+)/i);
    if (metaMatch && !/^utf-?8$/i.test(metaMatch[1])) {
        throw new Error(`${htmlPath}: unsupported charset ${metaMatch[1]}`);
    }

    return _hashAttrs(html);
}

/**
 * Extract inline script body hashes and on* attribute hashes from an HTML string.
 * Intended for in-memory use (e.g. SSR routes fetched at build time) where file I/O
 * is not available. Does not perform BOM or charset checks.
 *
 * @param {string} html
 * @returns {{ scripts: string[], attrs: string[], warnings: string[] }}
 *   scripts: 'sha256-<base64>' strings for each inline <script> body
 *   attrs:   'sha256-<base64>' strings for each unique on* attribute value
 *   warnings: non-fatal parse issues
 */
function extractInlineHashesFromHtml(html) {
    const { hashes: scripts, warnings: w1 } = _hashScripts(html);
    const { attrs, warnings: w2 } = _hashAttrs(html);
    return {
        scripts,
        attrs: attrs.map((a) => a.hash),
        warnings: [...w1, ...w2],
    };
}

module.exports = {
    extractInlineScriptHashes,
    extractInlineAttrHashes,
    extractInlineHashesFromHtml,
};
