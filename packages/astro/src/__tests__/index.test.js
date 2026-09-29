import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import dappfence from '../index.js';

const SECRET_KEY = '2d8fbeb769203997d2baa6ef960ab1a39af01dd9eef9caa212e927df77288832';
const RESOLVED_VIRTUAL_ID = '\0virtual:dappfence/attrs';

let tmpDirs = [];
afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tmpDirs = [];
});

async function makeOutDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-astro-'));
    tmpDirs.push(dir);
    await fs.writeFile(
        path.join(dir, 'index.html'),
        '<html><head></head><body>app</body></html>',
        'utf8'
    );
    return dir;
}

describe('astro:config:setup base-path handling', () => {
    it('prefixes the SSR-injected script tag with a non-root base', () => {
        const plugin = dappfence({ secretKey: SECRET_KEY });
        let capturedPlugins;
        plugin.hooks['astro:config:setup']({
            logger: { error: vi.fn() },
            config: { base: '/my-app/', build: {} },
            updateConfig: (cfg) => {
                capturedPlugins = cfg.vite.plugins;
            },
            addMiddleware: vi.fn(),
        });

        // dappfenceAttrsPlugin is always the first injected Vite plugin; its
        // virtual module resolves to a JS source exporting the pre-built tag.
        const loaded = capturedPlugins[0].load(RESOLVED_VIRTUAL_ID);
        expect(loaded).toContain('/my-app/dappfence.js');
        expect(loaded).toContain('/my-app/integrity-manifest.json');
        expect(loaded).not.toContain('\\"/dappfence.js\\"');
        expect(loaded).not.toContain('\\"/integrity-manifest.json\\"');
    });

    it('leaves the script tag unprefixed at a root base', () => {
        const plugin = dappfence({ secretKey: SECRET_KEY });
        let capturedPlugins;
        plugin.hooks['astro:config:setup']({
            logger: { error: vi.fn() },
            config: { base: '/', build: {} },
            updateConfig: (cfg) => {
                capturedPlugins = cfg.vite.plugins;
            },
            addMiddleware: vi.fn(),
        });

        const loaded = capturedPlugins[0].load(RESOLVED_VIRTUAL_ID);
        expect(loaded).toContain('\\"/dappfence.js\\"');
        expect(loaded).toContain('\\"/integrity-manifest.json\\"');
    });
});

describe('manifestSignatureType validation', () => {
    it('rejects a manifestSignatureType the build-time signer cannot produce', () => {
        expect(() =>
            dappfence({ secretKey: SECRET_KEY, manifestSignatureType: 'personal-sign-alt' })
        ).toThrow(/manifestSignatureType "personal-sign-alt" is not supported/);
    });
});

describe('astro:build:done path containment', () => {
    it('rejects a scriptSrc that escapes outDir', async () => {
        const outDir = await makeOutDir();
        const plugin = dappfence({ secretKey: SECRET_KEY, scriptSrc: '/../../evil.js' });
        const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        await expect(
            plugin.hooks['astro:build:done']({
                dir: pathToFileURL(outDir + path.sep),
                pages: [],
                logger: stubLogger,
            })
        ).rejects.toThrow(/scriptSrc ".*evil\.js" resolves outside/);
    });

    it('rejects a manifestPath that escapes outDir', async () => {
        const outDir = await makeOutDir();
        const plugin = dappfence({ secretKey: SECRET_KEY, manifestPath: '../../evil.json' });
        const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        await expect(
            plugin.hooks['astro:build:done']({
                dir: pathToFileURL(outDir + path.sep),
                pages: [],
                logger: stubLogger,
            })
        ).rejects.toThrow(/manifestPath ".*evil\.json" resolves outside/);
    });
});
