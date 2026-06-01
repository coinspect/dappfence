import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { buildScriptAttrs, buildScriptTag, injectScriptTag, generateManifest, DEFAULT_EXTENSIONS } =
    _require('@dappfence/manifest-tools/manifest');

const MINIMAL = { scriptSrc: '/dappfence.js' };
const LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs = [];
async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-next-test-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, 'main.js'), 'console.log("hi")', 'utf8');
    await fs.writeFile(
        path.join(dir, 'page.html'),
        '<html><head></head><body></body></html>',
        'utf8'
    );
    return dir;
}

afterEach(async () => {
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
    tmpDirs = [];
});

describe('buildScriptAttrs', () => {
    it('includes src from scriptSrc', () => {
        expect(buildScriptAttrs(MINIMAL).src).toBe('/dappfence.js');
    });

    it('omits falsy optional attributes', () => {
        const attrs = buildScriptAttrs({ ...MINIMAL, appSW: null, warningUrl: null });
        expect(attrs).not.toHaveProperty('data-app-sw');
        expect(attrs).not.toHaveProperty('data-warning-url');
    });

    it('includes all optional attributes when provided', () => {
        const attrs = buildScriptAttrs({
            scriptSrc: '/dappfence.js',
            manifestUrl: '/integrity-manifest.json',
            manifestSignatureType: 'noble-secp256k1-recovered-eth',
            manifestSignatureIdentity: '0xAbC123',
            appSW: '/app-sw.js',
            warningUrl: '/security-warning',
        });
        expect(attrs['data-manifest']).toBe('/integrity-manifest.json');
        expect(attrs['data-manifest-signature-type']).toBe('noble-secp256k1-recovered-eth');
        expect(attrs['data-manifest-signature-identity']).toBe('0xAbC123');
        expect(attrs['data-app-sw']).toBe('/app-sw.js');
        expect(attrs['data-warning-url']).toBe('/security-warning');
    });
});

describe('buildScriptTag', () => {
    it('produces a valid script element', () => {
        const tag = buildScriptTag(MINIMAL);
        expect(tag).toMatch(/^<script /);
        expect(tag).toContain('src="/dappfence.js"');
        expect(tag).toMatch(/<\/script>$/);
    });
});

describe('injectScriptTag', () => {
    it('injects into <head>', () => {
        const html = '<html><head></head><body></body></html>';
        const result = injectScriptTag(html, MINIMAL);
        expect(result).toContain('src="/dappfence.js"');
        expect(result.indexOf('<head>')).toBeLessThan(result.indexOf('src='));
    });

    it('does not double-inject', () => {
        const html = '<html><head></head><body></body></html>';
        const once = injectScriptTag(html, MINIMAL);
        const twice = injectScriptTag(once, MINIMAL);
        expect(once).toBe(twice);
    });
});

describe('generateManifest', () => {
    it('injects script tag into html pages', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const html = await fs.readFile(path.join(outDir, 'page.html'), 'utf8');
        expect(html).toContain('src="/dappfence.js"');
    });

    it('writes mode into the manifest payload', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'reporting',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.mode).toBe('reporting');
    });

    it('signs the manifest when secretKey is provided', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            secretKey: 'a'.repeat(64),
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.sig).toBeDefined();
        expect(manifest.pay).toBeDefined();
    });

    it('records dynamicRoutes in metadata', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            dynamicRoutes: ['/api/[id]', '/blog/[slug]'],
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.metadata.dynamicRoutes).toEqual(['/api/[id]', '/blog/[slug]']);
    });
});
