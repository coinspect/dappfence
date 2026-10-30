import { readFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';

const QUERY = '?template';
const INCLUDE_PATTERN = /^([ \t]*)<!--\s*@include\s+(\S+)((?:\s+[\w-]+="[^"]*")*)\s*-->[ \t]*$/gm;
const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;
const PLACEHOLDER_PATTERN = /\{\{\s*([\w-]+)\s*\}\}/g;

/**
 * Expand `<!-- @include path key="value" -->` directives in an HTML file.
 * See docs/templates.md for the full template system.
 *
 * - `path` is relative to the including file and must stay under `root`.
 * - Attributes fill `{{key}}` placeholders in the included file only; a
 *   placeholder without a value is a build error.
 * - Included lines are re-indented to the directive's indentation.
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
    return expand(file, root, onFile, [], {});
}

function expand(file, root, onFile, stack, values) {
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

    const filled = source.replace(PLACEHOLDER_PATTERN, (_match, key) => {
        if (!(key in values)) {
            throw new Error(`[html-includes] ${file}: no value for {{${key}}}`);
        }
        return values[key];
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
            childValues
        );
        return child
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => (line ? indent + line : line))
            .join('\n');
    });
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
