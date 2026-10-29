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
