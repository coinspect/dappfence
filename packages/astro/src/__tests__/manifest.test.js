import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TRANSFORM } from '@dappfence/core/constants';
import {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    buildPageSet,
    buildPathRules,
    buildContentRules,
    extractDynamicRoutes,
    extractProbedPatterns,
    resolveErrorPageRules,
    routePatternToProbeUrl,
    routePatternToPrefixKey,
    generateManifest,
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

// ── buildPathRules ────────────────────────────────────────────────────────────

describe('buildPathRules', () => {
    it('returns directory-index rule for directory format (default)', () => {
        expect(buildPathRules('directory')).toEqual([{ type: 'directory-index' }]);
    });

    it('returns directory-index rule when buildFormat is undefined', () => {
        expect(buildPathRules(undefined)).toEqual([{ type: 'directory-index' }]);
    });

    it('returns html-extension rule for file format', () => {
        expect(buildPathRules('file')).toEqual([{ type: 'html-extension' }]);
    });

    it('appends an error-page rule per entry', () => {
        expect(
            buildPathRules('directory', [
                { status: 404, url: '/404.html' },
                { status: 500, url: '/500' },
            ])
        ).toEqual([
            { type: 'directory-index' },
            { type: 'error-page', status: 404, url: '/404.html' },
            { type: 'error-page', status: 500, url: '/500' },
        ]);
    });

    it('appends the error-page rules under file format too', () => {
        expect(buildPathRules('file', [{ status: 404, url: '/404.html' }])).toEqual([
            { type: 'html-extension' },
            { type: 'error-page', status: 404, url: '/404.html' },
        ]);
    });

    it('omits error-page rules when the list is empty', () => {
        expect(buildPathRules('directory', [])).toEqual([{ type: 'directory-index' }]);
    });
});

// ── resolveErrorPageRules ─────────────────────────────────────────────────────

describe('resolveErrorPageRules', () => {
    it('returns an empty list when no error pages are in the build', () => {
        expect(resolveErrorPageRules({ pages: [{ pathname: 'about/' }] })).toEqual([]);
    });

    it('returns an empty list when pages, extraHashes, and routes are all empty', () => {
        expect(resolveErrorPageRules({})).toEqual([]);
    });

    it('resolves prerendered 404 to /404.html (directory build)', () => {
        // Astro writes 404.astro to dist/client/404.html even when build.format is
        // 'directory' (special case so static hosts can serve it at the root).
        // The disk walk keys it under /404.html — the error-page rule must match.
        expect(resolveErrorPageRules({ pages: [{ pathname: '404/' }] })).toEqual([
            { status: 404, url: '/404.html' },
        ]);
    });

    it('accepts /404/ pathname variant (leading slash)', () => {
        expect(resolveErrorPageRules({ pages: [{ pathname: '/404/' }] })).toEqual([
            { status: 404, url: '/404.html' },
        ]);
    });

    it('prefixes url with base when a base is set', () => {
        expect(resolveErrorPageRules({ base: '/app', pages: [{ pathname: '404/' }] })).toEqual([
            { status: 404, url: '/app/404.html' },
        ]);
    });

    it('prefers SSR-hashed /404/ over prerendered /404.html', () => {
        const extraHashes = { '/404/': 'sha256-abc' };
        const pages = [{ pathname: '404/' }];
        expect(resolveErrorPageRules({ extraHashes, pages })).toEqual([
            { status: 404, url: '/404/' },
        ]);
    });

    it('falls back to SSR-hashed /404 when /404/ is not hashed', () => {
        expect(resolveErrorPageRules({ extraHashes: { '/404': 'sha256-abc' } })).toEqual([
            { status: 404, url: '/404' },
        ]);
    });

    it('applies base to SSR-hashed extraHashes lookups', () => {
        expect(
            resolveErrorPageRules({ base: '/app', extraHashes: { '/app/404/': 'sha256-abc' } })
        ).toEqual([{ status: 404, url: '/app/404/' }]);
    });

    it('detects SSR 500.astro from routes (no on-disk hash) — prefers trailing slash', () => {
        // 500.astro with prerender=false shows up as an SSR route in Astro's
        // routes array. hashSSRRoutes fetches it via the built server, which
        // canonicalizes to /500/ when trailingSlash: 'always' is set. Default
        // to the trailing-slash form so contentRules and csp.pages entries
        // written under /500/ match at runtime.
        const routes = [{ pattern: '/500', isPrerendered: false }];
        expect(resolveErrorPageRules({ routes })).toEqual([{ status: 500, url: '/500/' }]);
    });

    it('prefers the cspPages-populated URL variant when both /500 and /500/ are declared', () => {
        // extractDynamicRoutes emits an empty {scripts:[],attrs:[]} entry under
        // the bare pattern /500. hashSSRRoutes populates the fetched URL /500/
        // with the actual extracted script hashes. We must pick /500/ so the
        // SW's csp.pages lookup finds the hashes.
        const routes = [{ pattern: '/500', isPrerendered: false }];
        const cspPages = {
            '/500': { scripts: [], attrs: [] },
            '/500/': { scripts: ['sha256-abc'], attrs: [] },
        };
        expect(resolveErrorPageRules({ routes, cspPages })).toEqual([
            { status: 500, url: '/500/' },
        ]);
    });

    it('returns both 404 and 500 when both are present', () => {
        const pages = [{ pathname: '404/' }];
        const routes = [{ pattern: '/500', isPrerendered: false }];
        expect(resolveErrorPageRules({ pages, routes })).toEqual([
            { status: 404, url: '/404.html' },
            { status: 500, url: '/500/' },
        ]);
    });

    it('ignores prerendered routes when looking for SSR error pages', () => {
        // A prerendered /500 would need a corresponding pages entry to be detected.
        const routes = [{ pattern: '/500', isPrerendered: true }];
        expect(resolveErrorPageRules({ routes })).toEqual([]);
    });
});

// ── buildContentRules ─────────────────────────────────────────────────────────

describe('buildContentRules', () => {
    it('returns empty array when not on Netlify', () => {
        expect(buildContentRules({ isNetlify: false })).toEqual([]);
    });

    it('returns empty array when called with no args', () => {
        expect(buildContentRules()).toEqual([]);
    });

    it('returns netlify-cdp transform rule on Netlify', () => {
        const rules = buildContentRules({ isNetlify: true });
        expect(rules).toHaveLength(3);
        expect(rules[0].action.type).toBe('transform');
        expect(rules[0].action.transform).toBe(TRANSFORM.NETLIFY_CDP);
        expect(rules[0].condition.resourceTypes).toContain('document');
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

    it('normalizes pathnames without a leading slash (Astro build:done form)', () => {
        // Astro's astro:build:done emits pathname without a leading slash
        // (e.g. 'about/', '404/') — verify we add leading slash so pageFilter's
        // lookup (which uses webPath with a leading slash from the walk) matches.
        const set = buildPageSet([{ pathname: 'about/' }, { pathname: '404/' }]);
        expect(set.has('/about/index.html')).toBe(true);
        expect(set.has('/about.html')).toBe(true);
        expect(set.has('/404/index.html')).toBe(true);
        expect(set.has('/404.html')).toBe(true);
    });

    it('handles multiple pages', () => {
        const set = buildPageSet([{ pathname: '/' }, { pathname: '/contact' }]);
        expect(set.has('/index.html')).toBe(true);
        expect(set.has('/contact/index.html')).toBe(true);
        expect(set.has('/contact.html')).toBe(true);
    });
});

// ── routePatternToProbeUrl ────────────────────────────────────────────────────

describe('routePatternToProbeUrl', () => {
    it('replaces a single param segment', () => {
        expect(routePatternToProbeUrl('/partials/dynamic/[id]')).toBe(
            '/partials/dynamic/__probe__'
        );
    });

    it('replaces multiple param segments', () => {
        expect(routePatternToProbeUrl('/blog/[category]/[slug]')).toBe('/blog/__probe__/__probe__');
    });

    it('replaces rest params', () => {
        expect(routePatternToProbeUrl('/api/[...path]')).toBe('/api/__probe__');
    });

    it('leaves param-free patterns unchanged', () => {
        expect(routePatternToProbeUrl('/about')).toBe('/about');
    });

    it('handles root-level param', () => {
        expect(routePatternToProbeUrl('/[id]')).toBe('/__probe__');
    });
});

// ── routePatternToPrefixKey ───────────────────────────────────────────────────

describe('routePatternToPrefixKey', () => {
    it('returns prefix up to the first param segment', () => {
        expect(routePatternToPrefixKey('/partials/dynamic/[id]')).toBe('/partials/dynamic/');
    });

    it('strips to the first param when multiple params exist', () => {
        expect(routePatternToPrefixKey('/blog/[category]/[slug]')).toBe('/blog/');
    });

    it('handles rest params', () => {
        expect(routePatternToPrefixKey('/api/items/[...slug]')).toBe('/api/items/');
    });

    it('returns "/" for a root-level param', () => {
        expect(routePatternToPrefixKey('/[id]')).toBe('/');
    });

    it('returns the pattern unchanged when there are no params', () => {
        expect(routePatternToPrefixKey('/about')).toBe('/about');
    });
});

// ── extractProbedPatterns ──────────────────────────────────────────────────────

describe('extractProbedPatterns', () => {
    it('returns empty array for null/undefined input', () => {
        expect(extractProbedPatterns(null)).toEqual([]);
        expect(extractProbedPatterns(undefined)).toEqual([]);
        expect(extractProbedPatterns([])).toEqual([]);
    });

    it('excludes prerendered routes', () => {
        const routes = [{ pattern: '/blog/[slug]', isPrerendered: true, params: ['slug'] }];
        expect(extractProbedPatterns(routes)).toEqual([]);
    });

    it('excludes param-free SSR routes', () => {
        const routes = [{ pattern: '/live', isPrerendered: false, params: [] }];
        expect(extractProbedPatterns(routes)).toEqual([]);
    });

    it('excludes redirect routes', () => {
        const routes = [
            { pattern: '/old/[id]', isPrerendered: false, type: 'redirect', params: ['id'] },
        ];
        expect(extractProbedPatterns(routes)).toEqual([]);
    });

    it('excludes internal Astro routes starting with /_', () => {
        const routes = [
            {
                pattern: '/_server-islands/[name]',
                isPrerendered: false,
                params: ['name'],
            },
        ];
        expect(extractProbedPatterns(routes)).toEqual([]);
    });

    it('returns patterns for parameterized SSR routes', () => {
        const routes = [
            { pattern: '/', isPrerendered: true, params: [] },
            { pattern: '/partials/dynamic/[id]', isPrerendered: false, params: ['id'] },
            {
                pattern: '/blog/[category]/[slug]',
                isPrerendered: false,
                params: ['category', 'slug'],
            },
        ];
        expect(extractProbedPatterns(routes)).toEqual([
            '/partials/dynamic/[id]',
            '/blog/[category]/[slug]',
        ]);
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

    it('writes manifest file with hashes for all files', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'console.log("hello")', 'utf8');
        await fs.writeFile(path.join(outDir, 'style.css'), 'body{}', 'utf8');
        await fs.writeFile(path.join(outDir, 'image.png'), 'fake png', 'utf8');

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/app.js']).toBeDefined();
        expect(manifest.pay.files['/style.css']).toBeDefined();
        expect(manifest.pay.files['/image.png']).toBeDefined();
    });

    it('excludes the manifest file itself', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'x', 'utf8');

        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

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

    it('emits a csp contentRule per dynamic-route prefix and no csp.pages entry when hashes are empty', async () => {
        const outDir = await setup();
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/api/[id]', isPrerendered: false },
            { pattern: '/live', isPrerendered: false },
        ];

        await generateManifest({
            outDir,
            routes,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.metadata.dynamicRoutes).toBeUndefined();
        expect(manifest.pay.csp.pages['/api/']).toBeUndefined();
        expect(manifest.pay.csp.pages['/live']).toBeUndefined();
        expect(manifest.pay.csp.pages['/']).toBeUndefined();
        const urlFilters = manifest.pay.contentRules
            .filter((r) => r.action?.type === 'csp')
            .map((r) => r.condition?.urlFilter);
        expect(urlFilters).toContain('/api/');
        expect(urlFilters).toContain('/live');
    });

    it('emits directory-index pathRules by default', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.pathRules).toEqual([{ type: 'directory-index' }]);
    });

    it('emits html-extension pathRules for file buildFormat', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            buildFormat: 'file',
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.pathRules).toEqual([{ type: 'html-extension' }]);
    });

    it('emits empty contentRules when not on Netlify', async () => {
        // CSP headers are layered on every document by the SW regardless of
        // contentRules; static documents fall through to the SW's default
        // `verify`. No implicit document-scoped rule is emitted here.
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.contentRules).toEqual([]);
    });

    it('emits only netlify-cdp contentRules when netlify: true is set', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            netlify: true,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.contentRules).toHaveLength(3);
        expect(manifest.pay.contentRules[0].action.transform).toBe('netlify-cdp');
    });

    it('emits a `csp` contentRule for each SSR route prefix', async () => {
        // SSR routes have no manifest.files entry — without an explicit `csp`
        // rule the SW would treat them as NOT_FOUND_IN_MANIFEST → violation.
        // The build must emit one rule per dynamic-route prefix so those
        // navigations skip hash-verify while still getting CSP.
        const outDir = await setup();
        const routes = [
            { pattern: '/api/data', isPrerendered: false },
            { pattern: '/blog/[slug]', isPrerendered: false },
            { pattern: '/blog/[slug]/comments', isPrerendered: false },
            { pattern: '/about', isPrerendered: true }, // static → no rule
        ];
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            exclude: [],
            mode: 'protected',
            routes,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        // /api/data has no bracket → prefix key is the route itself.
        // /blog/[slug] and /blog/[slug]/comments both collapse to '/blog/' —
        // the seenPrefixes dedupe keeps only one rule.
        expect(manifest.pay.contentRules).toEqual([
            {
                condition: { resourceTypes: ['document'], urlFilter: '/api/data' },
                action: { type: 'csp' },
            },
            {
                condition: { resourceTypes: ['document'], urlFilter: '/blog/' },
                action: { type: 'csp' },
            },
        ]);
    });

    it('SSR csp rules come before netlify transform rules', async () => {
        const outDir = await setup();
        const routes = [{ pattern: '/api/data', isPrerendered: false }];
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            netlify: true,
            exclude: [],
            mode: 'protected',
            routes,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.contentRules[0].action.type).toBe('csp');
        expect(manifest.pay.contentRules[1].action.transform).toBe('netlify-cdp');
    });
});
