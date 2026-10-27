import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
            command: 'build',
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
            command: 'build',
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

    it('rejects a relative base', () => {
        const plugin = dappfence({ secretKey: SECRET_KEY });
        expect(() =>
            plugin.hooks['astro:config:setup']({
                command: 'build',
                logger: { error: vi.fn() },
                config: { base: './', build: {} },
                updateConfig: vi.fn(),
                addMiddleware: vi.fn(),
            })
        ).toThrow(/base "\.\/" is relative/);
    });

    it('rejects a full-URL base', () => {
        const plugin = dappfence({ secretKey: SECRET_KEY });
        expect(() =>
            plugin.hooks['astro:config:setup']({
                command: 'build',
                logger: { error: vi.fn() },
                config: { base: 'https://cdn.example.com/assets/', build: {} },
                updateConfig: vi.fn(),
                addMiddleware: vi.fn(),
            })
        ).toThrow(/is a full URL/);
    });
});

// Everything the integration emits comes from astro:build:done, which only `astro build`
// runs. Outside a build it must register nothing — a middleware there injects a script tag
// pointing at a runtime and a manifest that were never generated — and it must not demand a
// signing key, which previously broke `astro dev` and `astro check` outright.
describe('astro:config:setup is inactive outside `astro build`', () => {
    const setup = (command, options = {}) => {
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const updateConfig = vi.fn();
        const addMiddleware = vi.fn();
        const run = () =>
            dappfence(options).hooks['astro:config:setup']({
                command,
                logger,
                config: { base: '/', build: {} },
                updateConfig,
                addMiddleware,
            });
        return { run, logger, updateConfig, addMiddleware };
    };

    for (const command of ['dev', 'sync', 'preview']) {
        it(`registers no middleware and no Vite plugins for \`astro ${command}\``, () => {
            const { run, updateConfig, addMiddleware } = setup(command, { secretKey: SECRET_KEY });
            run();
            expect(addMiddleware).not.toHaveBeenCalled();
            expect(updateConfig).not.toHaveBeenCalled();
        });

        // The regression this guards: `astro check` reports command 'sync', so a throw here
        // failed type-checking in any repo that had not set DAPPFENCE_SECRET_KEY.
        it(`warns instead of throwing without a secretKey for \`astro ${command}\``, () => {
            const { run, logger, addMiddleware } = setup(command);
            expect(run).not.toThrow();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no secretKey set/));
            expect(addMiddleware).not.toHaveBeenCalled();
        });
    }

    it('still throws without a secretKey for `astro build`', () => {
        const { run, logger } = setup('build');
        expect(run).toThrow(/secretKey is required/);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('registers middleware and Vite plugins for `astro build`', () => {
        const { run, updateConfig, addMiddleware } = setup('build', { secretKey: SECRET_KEY });
        run();
        expect(addMiddleware).toHaveBeenCalledWith(expect.objectContaining({ order: 'pre' }));
        expect(updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                vite: expect.objectContaining({ plugins: expect.any(Array) }),
            })
        );
    });
});

// Astro does not copy `.env` into process.env before evaluating
// astro.config.mjs, so the integration has to load the env files itself or a
// key that lives only in `.env` is invisible and every local build fails.
describe('secretKey resolution from `.env`', () => {
    async function makeProjectRoot(envContents) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-astro-env-'));
        tmpDirs.push(dir);
        if (envContents !== null) {
            await fs.writeFile(path.join(dir, '.env'), envContents, 'utf8');
        }
        return dir;
    }

    const setup = (command, root, options = {}) => {
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const run = () =>
            dappfence(options).hooks['astro:config:setup']({
                command,
                logger,
                config: { base: '/', build: {}, root: pathToFileURL(root + path.sep) },
                updateConfig: vi.fn(),
                addMiddleware: vi.fn(),
            });
        return { run, logger };
    };

    it('reads DAPPFENCE_SECRET_KEY from the project `.env` for `astro build`', async () => {
        const root = await makeProjectRoot(`DAPPFENCE_SECRET_KEY=${SECRET_KEY}\n`);
        const { run } = setup('build', root);
        expect(run).not.toThrow();
    });

    it('does not warn during `astro dev` when the key is only in `.env`', async () => {
        const root = await makeProjectRoot(`DAPPFENCE_SECRET_KEY=${SECRET_KEY}\n`);
        const { run, logger } = setup('dev', root);
        run();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('still throws for `astro build` when `.env` has no key', async () => {
        const root = await makeProjectRoot('SOMETHING_ELSE=1\n');
        const { run } = setup('build', root);
        expect(run).toThrow(/secretKey is required/);
    });

    // loadEnv overlays process.env on top of the parsed files, so the
    // documented precedence (explicit option > env var > `.env`) is preserved.
    it('lets a real environment variable outrank the `.env` entry', async () => {
        const root = await makeProjectRoot('DAPPFENCE_SECRET_KEY=not-a-valid-key\n');
        process.env.DAPPFENCE_SECRET_KEY = SECRET_KEY;
        try {
            const { run } = setup('build', root);
            expect(run).not.toThrow();
        } finally {
            delete process.env.DAPPFENCE_SECRET_KEY;
        }
    });

    it('lets the explicit secretKey option outrank both', async () => {
        const root = await makeProjectRoot('DAPPFENCE_SECRET_KEY=not-a-valid-key\n');
        process.env.DAPPFENCE_SECRET_KEY = 'also-not-valid';
        try {
            const { run } = setup('build', root, { secretKey: SECRET_KEY });
            expect(run).not.toThrow();
        } finally {
            delete process.env.DAPPFENCE_SECRET_KEY;
        }
    });
});

// A dev key hardcoded in astro.config.mjs silently outranks CI's real key, so
// the production manifest gets signed with a key committed to the repository.
// The precedence is intended; the silence is what makes it dangerous.
describe('conflicting secretKey sources', () => {
    const OTHER_KEY = 'a'.repeat(64);

    let emptyRoot;
    beforeEach(async () => {
        emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-astro-conflict-'));
        tmpDirs.push(emptyRoot);
    });

    // A dedicated empty root, so a stray `.env` in the shared temp directory
    // cannot inject a key and make these assertions flap.
    const setup = (command, options, env, root) => {
        const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
        const prev = process.env.DAPPFENCE_SECRET_KEY;
        if (env === undefined) {
            delete process.env.DAPPFENCE_SECRET_KEY;
        } else {
            process.env.DAPPFENCE_SECRET_KEY = env;
        }
        try {
            dappfence(options).hooks['astro:config:setup']({
                command,
                logger,
                config: { base: '/', build: {}, root: pathToFileURL(root + path.sep) },
                updateConfig: vi.fn(),
                addMiddleware: vi.fn(),
            });
        } finally {
            if (prev === undefined) {
                delete process.env.DAPPFENCE_SECRET_KEY;
            } else {
                process.env.DAPPFENCE_SECRET_KEY = prev;
            }
        }
        return logger;
    };

    it('warns when an explicit option and the env var are both set and differ', () => {
        const logger = setup('build', { secretKey: SECRET_KEY }, OTHER_KEY, emptyRoot);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringMatching(/both set, and they differ/)
        );
    });

    it('does not warn when only the explicit option is set', () => {
        const logger = setup('build', { secretKey: SECRET_KEY }, undefined, emptyRoot);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not warn when the two sources agree', () => {
        const logger = setup('build', { secretKey: SECRET_KEY }, SECRET_KEY, emptyRoot);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    // signManifest strips `0x` and decodes case-insensitively, so these are the
    // same key and must not be reported as a conflict.
    it('treats `0x`-prefixed and upper-case spellings as the same key', () => {
        const logger = setup(
            'build',
            { secretKey: `0x${SECRET_KEY.toUpperCase()}` },
            SECRET_KEY,
            emptyRoot
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    // Nothing is signed outside a build, so the conflict has no consequence there
    // and the warning would just be noise.
    it('stays quiet outside `astro build`', () => {
        const logger = setup('dev', { secretKey: SECRET_KEY }, OTHER_KEY, emptyRoot);
        expect(logger.warn).not.toHaveBeenCalled();
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
