import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dappfence from '../index.js';

const SECRET_KEY = '2d8fbeb769203997d2baa6ef960ab1a39af01dd9eef9caa212e927df77288832';

let tmpDirs = [];

afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs = [];
});

async function makeOutDir(files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-vite-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
    }
    return dir;
}

function runPlugin(plugin, outDir, base = '/') {
    plugin.configResolved({ root: outDir, build: { outDir: '.' }, base });
    return plugin.closeBundle();
}

describe('@dappfence/vite plugin shape', () => {
    it('declares build-only, post-enforced Rollup hooks', () => {
        const plugin = dappfence({ secretKey: SECRET_KEY });
        expect(plugin.name).toBe('@dappfence/vite');
        expect(plugin.apply).toBe('build');
        expect(plugin.enforce).toBe('post');
        expect(typeof plugin.configResolved).toBe('function');
        expect(typeof plugin.closeBundle).toBe('function');
    });

    it('rejects a manifestSignatureType the build-time signer cannot produce', () => {
        expect(() =>
            dappfence({ secretKey: SECRET_KEY, manifestSignatureType: 'personal-sign-alt' })
        ).toThrow(/manifestSignatureType "personal-sign-alt" is not supported/);
    });

    it('throws in configResolved when no secretKey is available', () => {
        const plugin = dappfence({});
        expect(() => plugin.configResolved({ root: '/tmp', build: { outDir: 'dist' } })).toThrow(
            /secretKey is required/
        );
    });

    it('falls back to DAPPFENCE_SECRET_KEY when no option is passed', () => {
        process.env.DAPPFENCE_SECRET_KEY = SECRET_KEY;
        try {
            const plugin = dappfence({});
            expect(() =>
                plugin.configResolved({ root: '/tmp', build: { outDir: 'dist' } })
            ).not.toThrow();
        } finally {
            delete process.env.DAPPFENCE_SECRET_KEY;
        }
    });
});

describe('@dappfence/vite closeBundle', () => {
    it('copies dappfence.js, injects the script tag, and writes a signed manifest', async () => {
        const outDir = await makeOutDir({
            'index.html': '<html><head></head><body>hi</body></html>',
        });
        const plugin = dappfence({ secretKey: SECRET_KEY });
        await runPlugin(plugin, outDir);

        const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
        expect(html).toContain('<script src="/dappfence.js"');

        const scriptStat = await fs.stat(path.join(outDir, 'dappfence.js'));
        expect(scriptStat.isFile()).toBe(true);

        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.sig).toBeTruthy();
        expect(manifest.pay.files['/index.html']).toBeTruthy();
        expect(manifest.pay.files['/dappfence.js']).toBeTruthy();
    });

    it('writes SPA-fallback routes, injects them, and hashes them under their web path', async () => {
        const outDir = await makeOutDir({
            'index.html': '<html><head></head><body>app</body></html>',
        });
        const plugin = dappfence({
            secretKey: SECRET_KEY,
            spaFallback: ['/btc', '/baby', '/rewards'],
        });
        await runPlugin(plugin, outDir);

        for (const route of ['btc', 'baby', 'rewards']) {
            const html = await fs.readFile(path.join(outDir, route), 'utf8');
            expect(html).toContain('<script src="/dappfence.js"');
        }

        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.files['/btc']).toBeTruthy();
        expect(manifest.pay.files['/baby']).toBeTruthy();
        expect(manifest.pay.files['/rewards']).toBeTruthy();
    });

    it('does not inject the script tag into an extensionless file outside spaFallback', async () => {
        const outDir = await makeOutDir({
            'index.html': '<html><head></head><body>app</body></html>',
            calculator: 'not html, just a stray extensionless file',
        });
        const plugin = dappfence({ secretKey: SECRET_KEY, spaFallback: ['/btc'] });
        await runPlugin(plugin, outDir);

        const stray = await fs.readFile(path.join(outDir, 'calculator'), 'utf8');
        expect(stray).toBe('not html, just a stray extensionless file');

        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        // still hashed — walk() tracks every file regardless of extension —
        // just not treated as an injectable page.
        expect(manifest.pay.files['/calculator']).toBeTruthy();
    });

    it('respects an explicit pageFilter override instead of the spaFallback default', async () => {
        const outDir = await makeOutDir({
            'index.html': '<html><head></head><body>app</body></html>',
        });
        const plugin = dappfence({
            secretKey: SECRET_KEY,
            spaFallback: ['/btc'],
            pageFilter: () => false,
        });
        await runPlugin(plugin, outDir);

        const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
        expect(html).not.toContain('<script src="/dappfence.js"');
        const btc = await fs.readFile(path.join(outDir, 'btc'), 'utf8');
        expect(btc).not.toContain('<script src="/dappfence.js"');
    });

    it('prefixes web paths with a non-root base', async () => {
        const outDir = await makeOutDir({
            'index.html': '<html><head></head><body>app</body></html>',
        });
        const plugin = dappfence({ secretKey: SECRET_KEY });
        await runPlugin(plugin, outDir, '/my-app/');

        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.files['/my-app/index.html']).toBeTruthy();
        expect(manifest.pay.files['/my-app/dappfence.js']).toBeTruthy();

        // The injected script tag must request assets under the base path too —
        // otherwise the browser looks for them at the domain root and 404s.
        const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
        expect(html).toContain('src="/my-app/dappfence.js"');
        expect(html).toContain('data-manifest="/my-app/integrity-manifest.json"');
        expect(html).not.toContain('src="/dappfence.js"');
    });
});
