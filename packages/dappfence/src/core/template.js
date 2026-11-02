/**
 * Marker inside partials/head.html's <style> tag that the page stylesheet
 * replaces. Its presence in every page is pinned by a unit test.
 */
export const STYLES_MARKER = '/* @styles */';

/**
 * Splice a compiled stylesheet into an expanded page template. A replacer
 * function (not a string) keeps `$&`-style sequences in the CSS literal.
 *
 * @param {string} html - page from a `*.html?template` import
 * @param {string} css - stylesheet from a `*.css?inline` import
 * @returns {string}
 */
export function renderTemplate(html, css) {
    return html.replace(STYLES_MARKER, () => css);
}

/**
 * `{{t:key}}` text markers, filled at runtime from the resolved messages (see
 * src/messages/index.js). build/html-includes.js leaves them alone: its
 * `{{name}}` pattern doesn't match the `t:` prefix.
 */
export const MESSAGE_MARKER_PATTERN = /\{\{t:([\w.]+)\}\}/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escape text for an HTML text node or a quoted attribute value.
 * @param {string} text
 */
export function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Replace every `{{t:key}}` marker with its message, HTML-escaped. Messages
 * are plain text, so manifest-supplied text can never add markup. An unknown
 * key throws: every marker is pinned to the catalog by a unit test, so this
 * only fires on a template edit that skipped the catalog.
 *
 * @param {string} html
 * @param {Readonly<Record<string, string>>} messages - from resolveMessages()
 * @returns {string}
 */
export function renderMessages(html, messages) {
    return html.replace(MESSAGE_MARKER_PATTERN, (_match, key) => {
        if (!Object.hasOwn(messages, key)) {
            throw new Error(`[template] no message for {{t:${key}}}`);
        }
        return escapeHtml(messages[key]);
    });
}
