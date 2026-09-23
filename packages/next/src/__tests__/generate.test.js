import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { TRANSFORM } from '@dappfence/core/constants';
import { readDynamicRoutes } from '../routes.js';
import { routePatternToProbeUrl, routePatternToPrefixKey } from '../ssr.js';
import { withDappfence, getDappfenceScriptAttrs, ATTRS_ENV_KEY } from '../index.js';
import { buildContentRules } from '../webpack-plugin.js';

const _require = createRequire(import.meta.url);
const { buildScriptAttrs, buildScriptTag, injectScriptTag, generateManifest } = _require(
    '@dappfence/manifest-tools/manifest'
);

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

    it('does not emit dynamicRoutes in metadata', async () => {
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
        expect(manifest.pay.metadata.dynamicRoutes).toBeUndefined();
    });

    it('emits pathRules and contentRules when provided (CSP document rules always prepended)', async () => {
        const outDir = await setup();
        const pathRules = [{ type: 'directory-index' }, { type: 'html-extension' }];
        const extraContentRules = [
            {
                condition: { resourceTypes: ['document'] },
                action: { type: 'transform', transform: TRANSFORM.NETLIFY_CDP },
            },
        ];
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            pathRules,
            contentRules: extraContentRules,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.pathRules).toEqual(pathRules);
        // CSP is layered on every document response by the SW; no implicit
        // document-scoped rule is emitted. Static docs fall through to `verify`;
        // SSR routes must declare `{ action: { type: 'csp' } }` themselves.
        expect(manifest.pay.contentRules).toEqual(extraContentRules);
    });
});

describe('buildContentRules', () => {
    it('returns empty array when not on Netlify', () => {
        expect(buildContentRules()).toEqual([]);
        expect(buildContentRules({ isNetlify: false })).toEqual([]);
    });

    it('returns netlify-cdp transform rule when isNetlify is true', () => {
        const rules = buildContentRules({ isNetlify: true });
        expect(rules).toHaveLength(3);
        expect(rules[0].action.transform).toBe(TRANSFORM.NETLIFY_CDP);
        expect(rules[0].condition.resourceTypes).toContain('document');
    });
});

describe('routePatternToProbeUrl', () => {
    it('replaces a simple bracket param with __probe__', () => {
        expect(routePatternToProbeUrl('/blog/[slug]')).toBe('/blog/__probe__');
    });

    it('replaces a catch-all bracket param with __probe__', () => {
        expect(routePatternToProbeUrl('/docs/[...rest]')).toBe('/docs/__probe__');
    });

    it('replaces multiple params', () => {
        expect(routePatternToProbeUrl('/a/[year]/[month]')).toBe('/a/__probe__/__probe__');
    });

    it('leaves exact paths unchanged', () => {
        expect(routePatternToProbeUrl('/dashboard')).toBe('/dashboard');
    });
});

describe('routePatternToPrefixKey', () => {
    it('returns the path up to the last slash before the first param', () => {
        expect(routePatternToPrefixKey('/blog/[slug]')).toBe('/blog/');
    });

    it('handles nested params', () => {
        expect(routePatternToPrefixKey('/blog/[year]/[slug]')).toBe('/blog/');
    });

    it('returns the pattern unchanged when there are no params', () => {
        expect(routePatternToPrefixKey('/dashboard')).toBe('/dashboard');
    });

    it('returns / when the param is at the root', () => {
        expect(routePatternToPrefixKey('/[id]')).toBe('/');
    });
});

describe('readDynamicRoutes', () => {
    it('returns empty lists when routes-manifest.json is missing', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        const result = await readDynamicRoutes(dir);
        expect(result.allRoutes).toEqual([]);
        expect(result.fixedRoutes).toEqual([]);
        expect(result.probedPatterns).toEqual([]);
        expect(result.isrRoutes).toEqual([]);
    });

    it('identifies ISR routes (initialRevalidateSeconds > 0) and excludes fully-static ones', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        const nextDir = path.join(dir, '.next');
        await fs.mkdir(nextDir, { recursive: true });
        await fs.writeFile(
            path.join(nextDir, 'routes-manifest.json'),
            JSON.stringify({ rewrites: [], dynamicRoutes: [] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'prerender-manifest.json'),
            JSON.stringify({
                routes: {
                    '/news': { initialRevalidateSeconds: 60, srcRoute: '/news' },
                    '/about': { initialRevalidateSeconds: false, srcRoute: '/about' },
                    '/blog/getting-started': {
                        initialRevalidateSeconds: 30,
                        srcRoute: '/blog/[slug]',
                    },
                },
                dynamicRoutes: {},
            }),
            'utf8'
        );
        const { isrRoutes } = await readDynamicRoutes(dir);
        expect(isrRoutes).toContain('/news');
        expect(isrRoutes).toContain('/blog/getting-started');
        expect(isrRoutes).not.toContain('/about');
    });

    it('extracts patterns from object-form rewrites and dynamic routes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        await fs.writeFile(
            path.join(dir, '.next', 'routes-manifest.json'),
            JSON.stringify({
                rewrites: {
                    beforeFiles: [
                        { source: '/api/:path*', destination: 'https://example.com/:path*' },
                    ],
                    afterFiles: [{ source: '/legacy/:slug', destination: '/new/:slug' }],
                    fallback: [],
                },
                dynamicRoutes: [{ page: '/blog/[slug]' }, { page: '/docs/[...rest]' }],
            }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes).toContain('/api/:path*');
        expect(allRoutes).toContain('/legacy/:slug');
        expect(allRoutes).toContain('/blog/[slug]');
        expect(allRoutes).toContain('/docs/[...rest]');
    });

    it('extracts patterns from flat-array rewrites (older Next.js)', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        await fs.writeFile(
            path.join(dir, '.next', 'routes-manifest.json'),
            JSON.stringify({
                rewrites: [
                    { source: '/proxy/:path*', destination: 'https://api.example.com/:path*' },
                ],
                dynamicRoutes: [],
            }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes).toContain('/proxy/:path*');
    });

    it('deduplicates patterns appearing in multiple sections', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        await fs.writeFile(
            path.join(dir, '.next', 'routes-manifest.json'),
            JSON.stringify({
                rewrites: {
                    beforeFiles: [{ source: '/dupe' }],
                    afterFiles: [{ source: '/dupe' }],
                    fallback: [],
                },
                dynamicRoutes: [],
            }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes.filter((r) => r === '/dupe')).toHaveLength(1);
    });

    it('detects SSR-only Pages Router pages not in prerender manifest', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        const nextDir = path.join(dir, '.next');
        await fs.mkdir(path.join(nextDir, 'server'), { recursive: true });
        await fs.writeFile(
            path.join(nextDir, 'routes-manifest.json'),
            JSON.stringify({ rewrites: [], dynamicRoutes: [] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'prerender-manifest.json'),
            JSON.stringify({ routes: { '/': {} }, dynamicRoutes: {} }),
            'utf8'
        );
        // /dashboard is SSR-only (not prerendered), / is static (prerendered)
        await fs.writeFile(
            path.join(nextDir, 'server', 'pages-manifest.json'),
            JSON.stringify({ '/': 'pages/index.js', '/dashboard': 'pages/dashboard.js' }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes).toContain('/dashboard');
        expect(allRoutes).not.toContain('/');
    });

    it('detects SSR-only App Router pages not in prerender manifest', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        const nextDir = path.join(dir, '.next');
        await fs.mkdir(path.join(nextDir, 'server'), { recursive: true });
        await fs.writeFile(
            path.join(nextDir, 'routes-manifest.json'),
            JSON.stringify({ rewrites: [], dynamicRoutes: [] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'prerender-manifest.json'),
            JSON.stringify({ routes: { '/about': {} }, dynamicRoutes: {} }),
            'utf8'
        );
        // /page → / (SSR), /about/page → /about (prerendered, skip)
        await fs.writeFile(
            path.join(nextDir, 'server', 'app-paths-manifest.json'),
            JSON.stringify({ '/page': 'app/page.js', '/about/page': 'app/about/page.js' }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes).toContain('/');
        expect(allRoutes).not.toContain('/about');
    });

    it('skips internal Next.js pages (/_app, /_error, etc.)', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        const nextDir = path.join(dir, '.next');
        await fs.mkdir(path.join(nextDir, 'server'), { recursive: true });
        await fs.writeFile(
            path.join(nextDir, 'routes-manifest.json'),
            JSON.stringify({ rewrites: [], dynamicRoutes: [] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'prerender-manifest.json'),
            JSON.stringify({ routes: {}, dynamicRoutes: {} }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'server', 'pages-manifest.json'),
            JSON.stringify({ '/_app': 'pages/_app.js', '/_error': 'pages/_error.js' }),
            'utf8'
        );
        const { allRoutes } = await readDynamicRoutes(dir);
        expect(allRoutes).not.toContain('/_app');
        expect(allRoutes).not.toContain('/_error');
    });

    it('classifies SSR-only fixed pages into fixedRoutes', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        const nextDir = path.join(dir, '.next');
        await fs.mkdir(path.join(nextDir, 'server'), { recursive: true });
        await fs.writeFile(
            path.join(nextDir, 'routes-manifest.json'),
            JSON.stringify({ rewrites: [], dynamicRoutes: [] }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'prerender-manifest.json'),
            JSON.stringify({ routes: {}, dynamicRoutes: {} }),
            'utf8'
        );
        await fs.writeFile(
            path.join(nextDir, 'server', 'pages-manifest.json'),
            JSON.stringify({ '/dashboard': 'pages/dashboard.js', '/live': 'pages/live.js' }),
            'utf8'
        );
        const { fixedRoutes, probedPatterns } = await readDynamicRoutes(dir);
        expect(fixedRoutes).toContain('/dashboard');
        expect(fixedRoutes).toContain('/live');
        expect(probedPatterns).toHaveLength(0);
    });

    it('classifies dynamic route pages into probedPatterns and excludes rewrites from fetching', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        await fs.writeFile(
            path.join(dir, '.next', 'routes-manifest.json'),
            JSON.stringify({
                rewrites: [
                    { source: '/proxy/:path*', destination: 'https://api.example.com/:path*' },
                ],
                dynamicRoutes: [{ page: '/blog/[slug]' }, { page: '/docs/[...rest]' }],
            }),
            'utf8'
        );
        const { allRoutes, fixedRoutes, probedPatterns } = await readDynamicRoutes(dir);
        expect(allRoutes).toContain('/proxy/:path*');
        expect(probedPatterns).toContain('/blog/[slug]');
        expect(probedPatterns).toContain('/docs/[...rest]');
        // Rewrites must not appear in fixedRoutes or probedPatterns
        expect(fixedRoutes).not.toContain('/proxy/:path*');
        expect(probedPatterns).not.toContain('/proxy/:path*');
    });
});

describe('withDappfence', () => {
    let savedEnv;

    beforeEach(() => {
        savedEnv = process.env[ATTRS_ENV_KEY];
        delete process.env[ATTRS_ENV_KEY];
    });

    afterEach(() => {
        if (savedEnv === undefined) {
            delete process.env[ATTRS_ENV_KEY];
        } else {
            process.env[ATTRS_ENV_KEY] = savedEnv;
        }
    });

    it('sets process.env[ATTRS_ENV_KEY] immediately so getDappfenceScriptAttrs works from node_modules', () => {
        expect(process.env[ATTRS_ENV_KEY]).toBeUndefined();
        withDappfence({ scriptSrc: '/dappfence.js' })({});
        expect(process.env[ATTRS_ENV_KEY]).toBeDefined();
        const stored = JSON.parse(process.env[ATTRS_ENV_KEY]);
        expect(stored.scriptSrc).toBe('/dappfence.js');
    });

    it('getDappfenceScriptAttrs returns attrs set by withDappfence', () => {
        withDappfence({ scriptSrc: '/dappfence.js', appSW: '/app-sw.js' })({});
        const attrs = getDappfenceScriptAttrs();
        expect(attrs.src).toBe('/dappfence.js');
        expect(attrs['data-app-sw']).toBe('/app-sw.js');
    });

    it('includes ATTRS_ENV_KEY in the returned Next.js env config (for DefinePlugin)', () => {
        const wrapped = withDappfence({ scriptSrc: '/dappfence.js' })({});
        expect(wrapped.env?.[ATTRS_ENV_KEY]).toBeDefined();
        expect(JSON.parse(wrapped.env[ATTRS_ENV_KEY]).scriptSrc).toBe('/dappfence.js');
    });
});
