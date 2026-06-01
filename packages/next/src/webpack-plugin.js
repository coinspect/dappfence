import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

export class DappfenceWebpackPlugin {
    constructor(opts, webpackOptions) {
        this.opts = opts;
        this.isServer = webpackOptions.isServer;
        this.nextConfig = webpackOptions.config || {};
    }

    apply(compiler) {
        // Only run once — after the client compilation.
        if (this.isServer) return;

        compiler.hooks.done.tapPromise('DappfencePlugin', async (stats) => {
            if (stats.hasErrors()) return;

            const isStaticExport = this.nextConfig.output === 'export';

            if (isStaticExport) {
                // Static export: HTML files are not ready yet at webpack done time.
                // Write config so the CLI (dappfence-next postbuild) can pick it up.
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

        await generateManifest({
            outDir: nextStaticDir,
            manifestPath: path.relative(
                nextStaticDir,
                path.join(publicDir, this.opts.manifestPath)
            ),
            extensions: this.opts.extensions,
            exclude: this.opts.exclude,
            secretKey: this.opts.secretKey,
            mode: this.opts.mode,
            scriptAttrs: null,
            logger,
        });

        logger.info(`DappFence: manifest written → public/${this.opts.manifestPath}`);
    }

    async _writeConfig() {
        const configPath = path.join(process.cwd(), '.next', 'dappfence-config.json');
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(this.opts, null, 2), 'utf8');
    }
}
