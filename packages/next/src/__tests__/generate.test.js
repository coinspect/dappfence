import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { TRANSFORM } from '@dappfence/core/constants';
import { readDynamicRoutes } from '../routes.js';
import { hashPrerenderedPages } from '../ssr.js';
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

    it('records dynamicRoutes in metadata', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

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

    it('emits pathRules and contentRules when provided', async () => {
        const outDir = await setup();
        const pathRules = [{ type: 'directory-index' }, { type: 'html-extension' }];
        const contentRules = [
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
            contentRules,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });
        const manifest = JSON.parse(
            await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8')
        );
        expect(manifest.pay.pathRules).toEqual(pathRules);
        expect(manifest.pay.contentRules).toEqual(contentRules);
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

describe('readDynamicRoutes', () => {
    it('returns empty array when routes-manifest.json is missing', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-routes-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        expect(await readDynamicRoutes(dir)).toEqual([]);
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
        const routes = await readDynamicRoutes(dir);
        expect(routes).toContain('/api/:path*');
        expect(routes).toContain('/legacy/:slug');
        expect(routes).toContain('/blog/[slug]');
        expect(routes).toContain('/docs/[...rest]');
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
        const routes = await readDynamicRoutes(dir);
        expect(routes).toContain('/proxy/:path*');
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
        const routes = await readDynamicRoutes(dir);
        expect(routes.filter((r) => r === '/dupe')).toHaveLength(1);
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
        const routes = await readDynamicRoutes(dir);
        expect(routes).toContain('/dashboard');
        expect(routes).not.toContain('/');
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
        const routes = await readDynamicRoutes(dir);
        expect(routes).toContain('/');
        expect(routes).not.toContain('/about');
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
        const routes = await readDynamicRoutes(dir);
        expect(routes).not.toContain('/_app');
        expect(routes).not.toContain('/_error');
    });
});

describe('hashPrerenderedPages', () => {
    async function writeHtml(dir, relPath, content = '<html><body>test</body></html>') {
        const abs = path.join(dir, relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
    }

    it('returns empty object when .next/server directories are absent', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await fs.mkdir(path.join(dir, '.next'), { recursive: true });
        expect(await hashPrerenderedPages(dir, '', LOGGER)).toEqual({});
    });

    it('maps index.html to /', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/app/index.html');
        const hashes = await hashPrerenderedPages(dir, '', LOGGER);
        expect(hashes['/']).toMatch(/^sha256-/);
    });

    it('maps nested html files to URL paths', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/app/about.html');
        await writeHtml(dir, '.next/server/app/blog/getting-started.html');
        const hashes = await hashPrerenderedPages(dir, '', LOGGER);
        expect(hashes['/about']).toMatch(/^sha256-/);
        expect(hashes['/blog/getting-started']).toMatch(/^sha256-/);
    });

    it('skips internal Next.js pages (_not-found, _error, etc.)', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/app/_not-found.html');
        await writeHtml(dir, '.next/server/pages/_error.html');
        await writeHtml(dir, '.next/server/app/about.html');
        const hashes = await hashPrerenderedPages(dir, '', LOGGER);
        expect(Object.keys(hashes)).toEqual(['/about']);
    });

    it('covers Pages Router html files', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/pages/404.html');
        await writeHtml(dir, '.next/server/pages/500.html');
        const hashes = await hashPrerenderedPages(dir, '', LOGGER);
        expect(hashes['/404']).toMatch(/^sha256-/);
        expect(hashes['/500']).toMatch(/^sha256-/);
    });

    it('prefixes all paths with basePath when provided', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/app/index.html');
        await writeHtml(dir, '.next/server/app/about.html');
        const hashes = await hashPrerenderedPages(dir, '/myapp', LOGGER);
        expect(hashes['/myapp/']).toMatch(/^sha256-/);
        expect(hashes['/myapp/about']).toMatch(/^sha256-/);
        expect(hashes['/']).toBeUndefined();
    });

    it('produces stable hashes — same content gives same hash', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-pp-'));
        tmpDirs.push(dir);
        await writeHtml(dir, '.next/server/app/about.html', '<html>stable</html>');
        const h1 = await hashPrerenderedPages(dir, '', LOGGER);
        const h2 = await hashPrerenderedPages(dir, '', LOGGER);
        expect(h1['/about']).toBe(h2['/about']);
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
