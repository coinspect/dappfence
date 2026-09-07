import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteSource, __internals } from '../patch-runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

async function readFixture(name) {
    return fs.readFile(path.join(FIXTURES, name), 'utf8');
}

describe('rewriteSource — Next.js 15.5.18 prod runtime', () => {
    it('wraps every emission template in inert JSON tags', async () => {
        const source = await readFixture('app-page.runtime.prod.excerpt.txt');
        const out = rewriteSource(source);

        // The three emission templates (combined bootstrap, bootstrap-only,
        // chunk) must be gone — no bare `self.__next_f.push(` inside a
        // template literal position.
        expect(out).not.toMatch(/\$\{[a-zA-Z_$]\}self\.__next_f\.push/);
        expect(out).not.toMatch(/\$\{[a-zA-Z_$]\}\(self\.__next_f=self\.__next_f/);

        // Every rewritten template ends in a JSON-tagged emission.
        expect(out).toContain('<script type="application/json" data-nfp>');
    });

    it('emits the reader-init script exactly once per bootstrap template', async () => {
        const source = await readFixture('app-page.runtime.prod.excerpt.txt');
        const out = rewriteSource(source);

        const readerCount = out.split(__internals.READER_INIT_MINIFIED).length - 1;
        // Two bootstrap templates in prod (combined and bootstrap-only); each
        // gets one reader tag.
        expect(readerCount).toBe(2);
    });

    it('preserves the ${...} interpolations so the rewritten literal still evaluates', async () => {
        const source = await readFixture('app-page.runtime.prod.excerpt.txt');
        const out = rewriteSource(source);
        // The two payload interpolations from the combined bootstrap survive.
        expect(out).toContain('${r4(JSON.stringify([0]))}');
        expect(out).toContain('${r4(JSON.stringify([2,a]))}');
        expect(out).toContain('${n}');
    });

    it('is idempotent — a second pass is a no-op', async () => {
        const source = await readFixture('app-page.runtime.prod.excerpt.txt');
        const once = rewriteSource(source);
        const twice = rewriteSource(once);
        expect(twice).toBe(once);
    });
});

describe('rewriteSource — Next.js 15.5.18 dev runtime', () => {
    it('handles unmangled identifier names (scriptStart, htmlInlinedData, …)', async () => {
        const source = await readFixture('app-page.runtime.dev.excerpt.txt');
        const out = rewriteSource(source);

        expect(out).not.toMatch(/\$\{scriptStart\}self\.__next_f\.push/);
        expect(out).not.toMatch(/\$\{scriptStart\}\(self\.__next_f=self\.__next_f/);
        expect(out).toContain('<script type="application/json" data-nfp>');
        // Unmangled dev payload names survive.
        expect(out).toContain('${htmlEscapeJsonString(JSON.stringify([0]))}');
        expect(out).toContain('${htmlInlinedData}');
    });
});

describe('rewriteSource — synthetic templates', () => {
    it('rewrites the chunk template with an arbitrary identifier name', () => {
        const input = 'foo(`${zz}self.__next_f.push(${payload})</script>`);';
        const out = rewriteSource(input);
        expect(out).toBe('foo(`<script type="application/json" data-nfp>${payload}</script>`);');
    });

    it('rewrites bootstrap-only with the reader tag', () => {
        const input = 'foo(`${aa}(self.__next_f=self.__next_f||[]).push(${boot})</script>`);';
        const out = rewriteSource(input);
        expect(out).toContain('<script>');
        expect(out).toContain(__internals.READER_INIT_MINIFIED);
        expect(out).toContain('${boot}');
    });

    it('rewrites combined bootstrap+data with two JSON tags and one reader', () => {
        const input =
            'foo(`${aa}(self.__next_f=self.__next_f||[]).push(${boot});self.__next_f.push(${data})</script>`);';
        const out = rewriteSource(input);
        const readerCount = out.split(__internals.READER_INIT_MINIFIED).length - 1;
        const jsonTagCount = out.split('<script type="application/json" data-nfp>').length - 1;
        expect(readerCount).toBe(1);
        expect(jsonTagCount).toBe(2);
        expect(out).toContain('${boot}');
        expect(out).toContain('${data}');
    });

    it('leaves source without emission templates untouched', () => {
        const input = 'const x = 1; self.__next_f = self.__next_f || [];';
        expect(rewriteSource(input)).toBe(input);
    });
});

describe('RUNTIME_PATH_RE', () => {
    it('matches all app-page runtime variants', () => {
        const paths = [
            '/n/next/dist/compiled/next-server/app-page.runtime.prod.js',
            '/n/next/dist/compiled/next-server/app-page.runtime.dev.js',
            '/n/next/dist/compiled/next-server/app-page-experimental.runtime.prod.js',
            '/n/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js',
            '/n/next/dist/compiled/next-server/app-page-turbo-experimental.runtime.dev.js',
        ];
        for (const p of paths) {
            expect(__internals.RUNTIME_PATH_RE.test(p)).toBe(true);
        }
    });

    it('does not match non-app-page runtimes', () => {
        const paths = [
            '/n/next/dist/compiled/next-server/pages.runtime.prod.js',
            '/n/next/dist/compiled/next-server/app-route.runtime.prod.js',
            '/n/next/dist/compiled/next-server/server.runtime.prod.js',
            '/n/next/dist/compiled/next-server/app-page.runtime.prod.js.map',
        ];
        for (const p of paths) {
            expect(__internals.RUNTIME_PATH_RE.test(p)).toBe(false);
        }
    });
});
