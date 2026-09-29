import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { TRANSFORM } from '@dappfence/core/constants';
import {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    generateManifest,
    resolveContained,
    normalizeBase,
} from '../manifest.js';

const MINIMAL = { scriptSrc: '/dappfence.js' };
const LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs = [];
async function setup() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-manifest-test-'));
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
        const pathRules = [{ type: 'directory-index' }];
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
        // CSP headers are now layered on every document response by the SW
        // regardless of contentRules — no implicit document-scoped rule is
        // injected. Static documents fall through to the SW's default `verify`;
        // SSR routes must declare `{ action: { type: 'csp' } }` themselves.
        expect(manifest.pay.contentRules).toEqual(extraContentRules);
    });

    it('emits empty pathRules and empty contentRules when nothing is provided', async () => {
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
        expect(manifest.pay.pathRules).toEqual([]);
        expect(manifest.pay.contentRules).toEqual([]);
    });

    it('skips injection when scriptAttrs is omitted', async () => {
        const outDir = await setup();
        await generateManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',

            exclude: [],
            mode: 'protected',
            logger: LOGGER,
        });
        const html = await fs.readFile(path.join(outDir, 'page.html'), 'utf8');
        expect(html).not.toContain('dappfence');
    });
});

describe('resolveContained', () => {
    async function makeRoot() {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'df-contained-'));
        tmpDirs.push(root);
        return root;
    }

    it('resolves a path that stays within root', async () => {
        const root = await makeRoot();
        const abs = await resolveContained(root, 'dappfence.js', 'scriptSrc');
        expect(abs).toBe(path.join(root, 'dappfence.js'));
    });

    it('rejects a relative path that escapes root via ..', async () => {
        const root = await makeRoot();
        await expect(resolveContained(root, '../../etc/evil.js', 'scriptSrc')).rejects.toThrow(
            /scriptSrc "\.\.\/\.\.\/etc\/evil\.js" resolves outside/
        );
    });

    it('rejects an absolute path outside root', async () => {
        const root = await makeRoot();
        await expect(resolveContained(root, '/etc/passwd', 'spaFallbackSource')).rejects.toThrow(
            /resolves outside/
        );
    });

    it('allows root itself (empty relative path)', async () => {
        const root = await makeRoot();
        const abs = await resolveContained(root, '.', 'manifestPath');
        expect(abs).toBe(path.resolve(root));
    });

    it('rejects a target that is itself a symlink pointing outside root', async () => {
        const root = await makeRoot();
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-contained-outside-'));
        tmpDirs.push(outsideDir);
        const secretFile = path.join(outsideDir, 'secret.txt');
        await fs.writeFile(secretFile, 'do not leak me', 'utf8');
        await fs.symlink(secretFile, path.join(root, 'dappfence.js'));

        await expect(resolveContained(root, 'dappfence.js', 'scriptSrc')).rejects.toThrow(
            /scriptSrc "dappfence\.js" resolves outside .* via a symlink/
        );
    });

    it('rejects a target under a symlinked ancestor directory pointing outside root', async () => {
        const root = await makeRoot();
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'df-contained-outside-'));
        tmpDirs.push(outsideDir);
        await fs.symlink(outsideDir, path.join(root, 'escape'));

        // 'escape/not-yet-created.html' doesn't exist yet, but its parent
        // ('escape') is a symlink pointing outside root — must still be caught.
        await expect(
            resolveContained(root, 'escape/not-yet-created.html', 'spaFallback')
        ).rejects.toThrow(
            /spaFallback ".*not-yet-created\.html" resolves outside .* via a symlink/
        );
    });

    it('allows a symlink that stays within root', async () => {
        const root = await makeRoot();
        await fs.writeFile(path.join(root, 'real.js'), 'console.log(1)', 'utf8');
        await fs.symlink(path.join(root, 'real.js'), path.join(root, 'alias.js'));

        const abs = await resolveContained(root, 'alias.js', 'scriptSrc');
        expect(abs).toBe(path.join(root, 'alias.js'));
    });
});

describe('normalizeBase', () => {
    it('treats "/" as no prefix', () => {
        expect(normalizeBase('/', 'label')).toBe('');
    });

    it('treats undefined as no prefix', () => {
        expect(normalizeBase(undefined, 'label')).toBe('');
    });

    it('strips the trailing slash from an absolute-path base', () => {
        expect(normalizeBase('/my-app/', 'label')).toBe('/my-app');
    });

    it('rejects a full URL base', () => {
        expect(() => normalizeBase('https://cdn.example.com/assets/', 'label')).toThrow(
            /base "https:\/\/cdn\.example\.com\/assets\/" is a full URL/
        );
    });

    it('rejects a protocol-relative base', () => {
        expect(() => normalizeBase('//cdn.example.com/assets/', 'label')).toThrow(/is a full URL/);
    });

    it('rejects a relative base', () => {
        expect(() => normalizeBase('./', 'label')).toThrow(/base "\.\/" is relative/);
    });

    it('rejects an empty-string base', () => {
        expect(() => normalizeBase('', 'label')).toThrow(/is relative/);
    });
});
