import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readDynamicRoutes } from './routes.js';

const _require = createRequire(import.meta.url);
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

export class DappfenceWebpackPlugin {
    constructor(opts, webpackOptions) {
        const { secretKey, ...publicOpts } = opts;
        this.opts = publicOpts;
        // Keep the signing key separate so it never ends up in serialized config files.
        this._secretKey = secretKey || null;
        this.isServer = webpackOptions.isServer;
        this.isDev = webpackOptions.dev || false;
        this.nextConfig = webpackOptions.config || {};
    }

    apply(compiler) {
        // Only run once — after the client compilation.
        if (this.isServer) return;

        this.projectRoot = compiler.context;

        compiler.hooks.done.tapPromise('DappfencePlugin', async (stats) => {
            if (stats.hasErrors()) return;
            if (this.isDev) return;

            const isStaticExport = this.nextConfig.output === 'export';

            if (isStaticExport) {
                await this._writeConfig();
                console.log(
                    'DappFence: static export detected — run `dappfence-next` as a postbuild step to generate the manifest.'
                );
                return;
            }

            await this._processSSR(compiler.context);
        });
    }

    async _processSSR(projectRoot) {
        const { generateManifest } = _require('@dappfence/manifest-tools/manifest');

        // Copy dappfence.js into public/ so Next.js serves it at the root.
        const publicDir = path.join(projectRoot, 'public');
        await fs.mkdir(publicDir, { recursive: true });
        const destRel = this.opts.scriptSrc.replace(/^\//, '');
        const destAbs = path.join(publicDir, destRel);
        await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
        logger.info(`DappFence: copied dappfence.js → public/${destRel}`);

        // Hash static Next.js assets served under /_next/static/.
        // HTML is SSR so we don't hash it here; script injection is manual via layout.
        const nextStaticDir = path.join(projectRoot, '.next', 'static');
        const nextStaticExists = await fs
            .stat(nextStaticDir)
            .then(() => true)
            .catch(() => false);

        if (!nextStaticExists) {
            logger.warn('DappFence: no static assets found to hash');
            return;
        }

        const dynamicRoutes = await readDynamicRoutes(projectRoot);

        await generateManifest({
            outDir: nextStaticDir,
            manifestPath: path.relative(
                nextStaticDir,
                path.join(publicDir, this.opts.manifestPath)
            ),
            extensions: this.opts.extensions,
            exclude: this.opts.exclude,
            secretKey: this._secretKey,
            mode: this.opts.mode,
            dynamicRoutes,
            scriptAttrs: null,
            logger,
        });

        logger.info(`DappFence: manifest written → public/${this.opts.manifestPath}`);
    }

    // Write build config (no secret key) for the dappfence-next CLI (static export only).
    // The CLI reads the signing key from DAPPFENCE_SECRET_KEY at runtime.
    async _writeConfig() {
        const configPath = path.join(this.projectRoot, '.next', 'dappfence-config.json');
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(this.opts, null, 2), 'utf8');
    }
}
