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

    it('inlines an .svg without its XML declaration or comments', () => {
        write(
            'logo.svg',
            '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 1 1">\n  <!-- Generator: x -->\n  <path d="M0 0"/>\n</svg>\n'
        );
        const page = write('page.html', '<span>\n    <!-- @include logo.svg -->\n</span>\n');
        expect(expandIncludes(page, root)).toBe(
            '<span>\n    <svg viewBox="0 0 1 1">\n      <path d="M0 0"/>\n    </svg>\n</span>\n'
        );
    });

    it('prefixes every id and same-document reference in an .svg with id-prefix', () => {
        write(
            'iso.svg',
            '<svg id="iso">\n' +
                '  <linearGradient id="g"/>\n' +
                '  <path data-id="keep" style="fill: url(#g)"/>\n' +
                '  <use href="#g"/>\n' +
                '  <use xlink:href="#g"/>\n' +
                '  <a href="https://example.com/#top"/>\n' +
                '</svg>\n'
        );
        const page = write('page.html', '<!-- @include iso.svg id-prefix="a" -->');
        expect(expandIncludes(page, root)).toBe(
            '<svg id="a-iso">\n' +
                '  <linearGradient id="a-g"/>\n' +
                '  <path data-id="keep" style="fill: url(#a-g)"/>\n' +
                '  <use href="#a-g"/>\n' +
                '  <use xlink:href="#a-g"/>\n' +
                '  <a href="https://example.com/#top"/>\n' +
                '</svg>'
        );
    });

    it('leaves .svg ids alone without id-prefix', () => {
        write('iso.svg', '<svg id="iso"><path style="fill: url(#g)"/></svg>\n');
        const page = write('page.html', '<!-- @include iso.svg -->');
        expect(expandIncludes(page, root)).toBe(
            '<svg id="iso"><path style="fill: url(#g)"/></svg>'
        );
    });

    it('rejects an id-prefix that would not make a valid id', () => {
        write('iso.svg', '<svg id="iso"/>\n');
        const page = write('page.html', '<!-- @include iso.svg id-prefix="1 x" -->');
        expect(() => expandIncludes(page, root)).toThrow(
            /id-prefix "1 x" must start with a letter/
        );
    });

    it('lets the same .svg appear twice under different prefixes', () => {
        write('iso.svg', '<svg id="iso"><linearGradient id="g"/></svg>\n');
        write('logo.html', '<!-- @include iso.svg id-prefix="{{prefix=df-logo}}" -->');
        const page = write(
            'page.html',
            '<!-- @include logo.html -->\n<!-- @include logo.html prefix="second" -->\n'
        );
        expect(expandIncludes(page, root)).toBe(
            '<svg id="df-logo-iso"><linearGradient id="df-logo-g"/></svg>\n' +
                '<svg id="second-iso"><linearGradient id="second-g"/></svg>\n'
        );
    });

    it('numbers repeated copies of an .svg included with the same prefix', () => {
        write('iso.svg', '<svg id="iso"><path style="fill: url(#g)"/></svg>\n');
        write('logo.svg', '<svg id="word"/>\n');
        write(
            'logo.html',
            '<!-- @include iso.svg id-prefix="{{prefix=df-logo}}" -->\n' +
                '<!-- @include logo.svg id-prefix="{{prefix=df-logo}}" -->\n'
        );
        const page = write(
            'page.html',
            '<!-- @include logo.html -->\n<!-- @include logo.html -->\n<!-- @include logo.html -->\n'
        );
        expect(expandIncludes(page, root)).toBe(
            '<svg id="df-logo-iso"><path style="fill: url(#df-logo-g)"/></svg>\n' +
                '<svg id="df-logo-word"/>\n' +
                '<svg id="df-logo-2-iso"><path style="fill: url(#df-logo-2-g)"/></svg>\n' +
                '<svg id="df-logo-2-word"/>\n' +
                '<svg id="df-logo-3-iso"><path style="fill: url(#df-logo-3-g)"/></svg>\n' +
                '<svg id="df-logo-3-word"/>\n'
        );
    });

    it('throws on a duplicate id in the expanded page', () => {
        write('row.html', '<p id="row">x</p>');
        const page = write('page.html', '<!-- @include row.html -->\n<!-- @include row.html -->\n');
        expect(() => expandIncludes(page, root)).toThrow(/duplicate id "row"/);
    });

    it('throws when an explicit id-prefix collides with a numbered copy', () => {
        write('iso.svg', '<svg id="iso"/>\n');
        const page = write(
            'page.html',
            '<!-- @include iso.svg id-prefix="a" -->\n' +
                '<!-- @include iso.svg id-prefix="a" -->\n' +
                '<!-- @include iso.svg id-prefix="a-2" -->\n'
        );
        expect(() => expandIncludes(page, root)).toThrow(/duplicate id "a-2-iso"/);
    });

    it('uses a {{key=default}} placeholder default unless the include sets the key', () => {
        write('head.html', '<title>{{title=Untitled}}</title>');
        const bare = write('bare.html', '<!-- @include head.html -->');
        const set = write('set.html', '<!-- @include head.html title="Hi" -->');
        expect(expandIncludes(bare, root)).toBe('<title>Untitled</title>');
        expect(expandIncludes(set, root)).toBe('<title>Hi</title>');
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
