import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { expandIncludes } from '../html-includes.js';

let root;

function write(rel, content) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'html-includes-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('expandIncludes', () => {
    it('inlines a partial relative to the including file, re-indented', () => {
        write('partials/a.html', '<p>one</p>\n<p>two</p>\n');
        const page = write(
            'pages/page.html',
            '<div>\n    <!-- @include ../partials/a.html -->\n</div>\n'
        );
        expect(expandIncludes(page, root)).toBe('<div>\n    <p>one</p>\n    <p>two</p>\n</div>\n');
    });

    it('fills {{key}} placeholders from include attributes', () => {
        write('head.html', '<title>{{title}}</title>');
        const page = write('page.html', '<!-- @include head.html title="Hi there" -->');
        expect(expandIncludes(page, root)).toBe('<title>Hi there</title>');
    });

    it('expands nested includes and reports every file read', () => {
        write('c.html', 'C');
        write('b.html', '<!-- @include c.html -->');
        const page = write('a.html', '<!-- @include b.html -->');
        const seen = [];
        expect(expandIncludes(page, root, (f) => seen.push(f))).toBe('C');
        expect(seen).toEqual([page, join(root, 'b.html'), join(root, 'c.html')]);
    });

    it('throws on an unfilled placeholder', () => {
        write('head.html', '<title>{{title}}</title>');
        const page = write('page.html', '<!-- @include head.html -->');
        expect(() => expandIncludes(page, root)).toThrow(/no value for \{\{title\}\}/);
    });

    it('throws on a missing partial, naming the including file', () => {
        const page = write('page.html', '<!-- @include nope.html -->');
        expect(() => expandIncludes(page, root)).toThrow(
            /cannot read .*nope\.html \(included from/
        );
    });

    it('throws on an include cycle', () => {
        write('b.html', '<!-- @include a.html -->');
        const page = write('a.html', '<!-- @include b.html -->');
        expect(() => expandIncludes(page, root)).toThrow(/include cycle/);
    });

    it('refuses paths that escape the root', () => {
        const page = write('page.html', '<!-- @include ../outside.html -->');
        expect(() => expandIncludes(page, root)).toThrow(/is outside/);
    });
});
