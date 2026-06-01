import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    buildPageSet,
    extractDynamicRoutes,
    generateManifest,
    DEFAULT_EXTENSIONS,
} from '../manifest.js';

const MINIMAL = { scriptSrc: '/dappfence.js' };

// ── buildScriptAttrs ──────────────────────────────────────────────────────────

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

// ── buildScriptTag ────────────────────────────────────────────────────────────

describe('buildScriptTag', () => {
    it('produces a valid script element', () => {
        const tag = buildScriptTag(MINIMAL);
        expect(tag).toMatch(/^<script /);
        expect(tag).toContain('src="/dappfence.js"');
        expect(tag).toMatch(/<\/script>$/);
    });

    it('includes data attributes in the tag', () => {
        const tag = buildScriptTag({
            ...MINIMAL,
            manifestUrl: '/integrity-manifest.json',
        });
        expect(tag).toContain('data-manifest="/integrity-manifest.json"');
    });
});

// ── injectScriptTag ───────────────────────────────────────────────────────────

describe('injectScriptTag', () => {
    it('injects after <head>', () => {
        const html = '<html><head></head><body></body></html>';
        const result = injectScriptTag(html, MINIMAL);
        expect(result).toContain('<head>\n    <script src="/dappfence.js"');
    });

    it('injects after <head> with attributes', () => {
        const html = '<html><head lang="en"></head><body></body></html>';
        const result = injectScriptTag(html, MINIMAL);
        expect(result).toContain('<head lang="en">\n    <script');
    });

    it('does not double-inject on repeated calls', () => {
        const html = '<html><head></head><body></body></html>';
        const once = injectScriptTag(html, MINIMAL);
        const twice = injectScriptTag(once, MINIMAL);
        expect(twice).toBe(once);
    });

    it('returns html unchanged when no <head> is present', () => {
        const fragment = '<div>hello</div>';
        expect(injectScriptTag(fragment, MINIMAL)).toBe(fragment);
    });
});

// ── extractDynamicRoutes ──────────────────────────────────────────────────────

describe('extractDynamicRoutes', () => {
    it('returns empty array for null/undefined input', () => {
        expect(extractDynamicRoutes(null)).toEqual([]);
        expect(extractDynamicRoutes(undefined)).toEqual([]);
        expect(extractDynamicRoutes([])).toEqual([]);
    });

    it('returns empty array when all routes are prerendered', () => {
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/about', isPrerendered: true },
        ];
        expect(extractDynamicRoutes(routes)).toEqual([]);
    });

    it('returns patterns for non-prerendered routes', () => {
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/blog/[slug]', isPrerendered: false },
            { pattern: '/_server-islands/[name]', isPrerendered: false },
        ];
        expect(extractDynamicRoutes(routes)).toEqual(['/blog/[slug]', '/_server-islands/[name]']);
    });

    it('filters out routes with no pattern', () => {
        const routes = [
            { pattern: null, isPrerendered: false },
            { pattern: '/api/data', isPrerendered: false },
        ];
        expect(extractDynamicRoutes(routes)).toEqual(['/api/data']);
    });
});

// ── buildPageSet ──────────────────────────────────────────────────────────────

describe('buildPageSet', () => {
    it('returns empty set for no pages', () => {
        expect(buildPageSet([]).size).toBe(0);
    });

    it('maps root pathname to /index.html only', () => {
        const set = buildPageSet([{ pathname: '/' }]);
        expect(set.has('/index.html')).toBe(true);
        expect(set.size).toBe(1);
    });

    it('maps nested pathname to both index.html and .html forms', () => {
        const set = buildPageSet([{ pathname: '/about/' }]);
        expect(set.has('/about/index.html')).toBe(true);
        expect(set.has('/about.html')).toBe(true);
        expect(set.size).toBe(2);
    });

    it('handles pathnames without trailing slash', () => {
        const set = buildPageSet([{ pathname: '/blog' }]);
        expect(set.has('/blog/index.html')).toBe(true);
        expect(set.has('/blog.html')).toBe(true);
    });

    it('handles multiple pages', () => {
        const set = buildPageSet([{ pathname: '/' }, { pathname: '/contact' }]);
        expect(set.has('/index.html')).toBe(true);
        expect(set.has('/contact/index.html')).toBe(true);
        expect(set.has('/contact.html')).toBe(true);
    });
});

// ── generateManifest (integration) ───────────────────────────────────────────

async function makeTmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-test-'));
}

const LOGGER = {
    info: () => {},
    warn: () => {},
    error: () => {},
};

describe('generateManifest', () => {
    const tmpDirs = [];

    afterEach(async () => {
        for (const dir of tmpDirs) {
            await fs.rm(dir, { recursive: true, force: true });
        }
        tmpDirs.length = 0;
    });

    async function setup() {
        const outDir = await makeTmpDir();
        tmpDirs.push(outDir);
        return outDir;
    }

    it('writes manifest file with hashes for tracked extensions', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'console.log("hello")', 'utf8');
        await fs.writeFile(path.join(outDir, 'style.css'), 'body{}', 'utf8');
        await fs.writeFile(path.join(outDir, 'image.png'), 'fake png', 'utf8');

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/app.js']).toBeDefined();
        expect(manifest.pay.files['/style.css']).toBeDefined();
        expect(manifest.pay.files['/image.png']).toBeUndefined();
    });

    it('excludes the manifest file itself', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'x', 'utf8');

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/integrity-manifest.json']).toBeUndefined();
    });

    it('respects the exclude option', async () => {
        const outDir = await setup();
        const adminDir = path.join(outDir, 'admin');
        await fs.mkdir(adminDir);
        await fs.writeFile(path.join(adminDir, 'app.js'), 'secret', 'utf8');
        await fs.writeFile(path.join(outDir, 'public.js'), 'open', 'utf8');

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: ['/admin'],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/admin/app.js']).toBeUndefined();
        expect(manifest.pay.files['/public.js']).toBeDefined();
    });

    it('injects script tag into HTML pages when pages list provided', async () => {
        const outDir = await setup();
        await fs.writeFile(
            path.join(outDir, 'index.html'),
            '<html><head></head><body></body></html>',
            'utf8'
        );

        await generateManifest({
            outDir,
            pages: [{ pathname: '/' }],
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
        expect(html).toContain('src="/dappfence.js"');
    });

    it('falls back to extension-based detection when no pages list', async () => {
        const outDir = await setup();
        await fs.writeFile(
            path.join(outDir, 'page.html'),
            '<html><head></head><body></body></html>',
            'utf8'
        );

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

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.mode).toBe('reporting');
    });

    it('signs the manifest when secretKey is provided', async () => {
        const outDir = await setup();
        const secretKey = 'a'.repeat(64);

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            secretKey,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.sig).toBeDefined();
        expect(manifest.pay).toBeDefined();
    });

    it('includes dynamicRoutes in metadata when routes provided', async () => {
        const outDir = await setup();
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/api/[id]', isPrerendered: false },
        ];

        await generateManifest({
            outDir,
            routes,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.metadata.dynamicRoutes).toEqual(['/api/[id]']);
    });
});
