import { readFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';

const QUERY = '?template';
const INCLUDE_PATTERN = /^([ \t]*)<!--\s*@include\s+(\S+)((?:\s+[\w-]+="[^"]*")*)\s*-->[ \t]*$/gm;
const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;
const PLACEHOLDER_PATTERN = /\{\{\s*([\w-]+)\s*(?:=([^}]*))?\}\}/g;
const ID_PREFIX_PATTERN = /^[A-Za-z][\w-]*$/;
const ID_ATTR_PATTERN = /\sid="([^"]*)"/g;

/**
 * Expand `<!-- @include path key="value" -->` directives in an HTML file.
 * See docs/templates.md for the full template system.
 *
 * - `path` is relative to the including file and must stay under `root`.
 * - Attributes fill `{{key}}` placeholders in the included file only. A
 *   placeholder can carry a default, `{{key=value}}`, used when the include
 *   has no such attribute; one with neither is a build error.
 * - Included lines are re-indented to the directive's indentation.
 * - An `.svg` file is inlined as markup, minus its `<?xml ?>` declaration and
 *   comments, so a designer's export can be included unedited. With an
 *   `id-prefix="p"` attribute every `id` becomes `p-<id>`, and so do the
 *   `url(#…)` and `href="#…"` references to it. When the same SVG is included
 *   again with the same prefix, that copy gets `p-2`, `p-3`, … (in include
 *   order), so a partial carrying an SVG can be included any number of times.
 * - The expanded file must not repeat an `id`; a duplicate is a build error.
 *
 * Pure string work with no clock or environment input, so the output depends
 * only on the source files (release builds must reproduce byte-for-byte).
 *
 * @param {string} file - absolute path of the entry file
 * @param {string} root - directory includes may not escape
 * @param {(file: string) => void} [onFile] - called for every file read
 * @returns {string}
 */
export function expandIncludes(file, root, onFile = () => {}) {
    // Counts SVG includes per (file, id-prefix) to number repeated copies.
    const svgCopies = new Map();
    const html = expand(file, root, onFile, [], {}, svgCopies);
    const seen = new Set();
    for (const [, id] of html.matchAll(ID_ATTR_PATTERN)) {
        if (seen.has(id)) {
            throw new Error(
                `[html-includes] ${file}: duplicate id "${id}". Give repeated markup ` +
                    'distinct ids; an SVG include can use id-prefix.'
            );
        }
        seen.add(id);
    }
    return html;
}

function expand(file, root, onFile, stack, values, svgCopies) {
    const rel = relative(root, file);
    if (rel.startsWith('..') || rel.split(sep).includes('..')) {
        throw new Error(`[html-includes] ${file} is outside ${root}`);
    }
    if (stack.includes(file)) {
        throw new Error(`[html-includes] include cycle: ${[...stack, file].join(' -> ')}`);
    }
    onFile(file);
    let source;
    try {
        source = readFileSync(file, 'utf-8');
    } catch (err) {
        const from = stack.length ? ` (included from ${stack[stack.length - 1]})` : '';
        throw new Error(`[html-includes] cannot read ${file}${from}: ${err.message}`);
    }

    if (file.endsWith('.svg')) {
        let prefix = values['id-prefix'];
        if (prefix !== undefined) {
            const key = `${file}\0${prefix}`;
            const copy = (svgCopies.get(key) ?? 0) + 1;
            svgCopies.set(key, copy);
            if (copy > 1) {
                prefix = `${prefix}-${copy}`;
            }
        }
        source = inlineSvg(source, file, prefix);
    }

    const filled = source.replace(PLACEHOLDER_PATTERN, (_match, key, fallback) => {
        if (key in values) {
            return values[key];
        }
        if (fallback !== undefined) {
            return fallback.trim();
        }
        throw new Error(`[html-includes] ${file}: no value for {{${key}}}`);
    });

    return filled.replace(INCLUDE_PATTERN, (_match, indent, path, attrs) => {
        const childValues = Object.fromEntries(
            [...attrs.matchAll(ATTR_PATTERN)].map(([, key, value]) => [key, value])
        );
        const child = expand(
            resolve(dirname(file), path),
            root,
            onFile,
            [...stack, file],
            childValues,
            svgCopies
        );
        return child
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => (line ? indent + line : line))
            .join('\n');
    });
}

/**
 * Turn a standalone SVG file into markup that can sit inside an HTML page:
 * drop the XML declaration (an HTML parser turns it into a bogus comment) and
 * editor comments such as Illustrator's "Generator" line. With a prefix,
 * namespace every id and every same-document reference to one.
 *
 * @param {string} source
 * @param {string} file - for error messages
 * @param {string} [prefix]
 */
function inlineSvg(source, file, prefix) {
    let svg = source.replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    if (prefix !== undefined) {
        if (!ID_PREFIX_PATTERN.test(prefix)) {
            throw new Error(
                `[html-includes] ${file}: id-prefix "${prefix}" must start with a letter ` +
                    'and contain only letters, digits, "_" and "-"'
            );
        }
        svg = svg
            .replace(/(\sid=")([^"]*)"/g, `$1${prefix}-$2"`)
            .replace(/url\(\s*#([^)\s]+)\s*\)/g, `url(#${prefix}-$1)`)
            .replace(/(\s(?:xlink:)?href=")#([^"]*)"/g, `$1#${prefix}-$2"`);
    }
    return (
        svg
            .split('\n')
            .filter((line) => line.trim())
            .join('\n') + '\n'
    );
}

/**
 * Vite plugin: `import html from './page.html?template'` returns the page with
 * every `@include` expanded, as a string.
 *
 * @param {{ root: string }} options - directory includes may not escape
 */
export default function htmlIncludes({ root }) {
    return {
        name: 'dappfence-html-includes',
        enforce: 'pre',
        load(id) {
            if (!id.endsWith(QUERY)) {
                return null;
            }
            const file = id.slice(0, -QUERY.length);
            const html = expandIncludes(file, root, (f) => this.addWatchFile(f));
            return { code: `export default ${JSON.stringify(html)};`, map: null };
        },
    };
}
