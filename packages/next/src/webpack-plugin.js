import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const { buildNetlifyContentRules } = _require('@dappfence/manifest-tools/manifest');

const DEFAULT_PATH_RULES = [{ type: 'directory-index' }, { type: 'html-extension' }];

function buildContentRules({ isNetlify = false } = {}) {
    return isNetlify ? buildNetlifyContentRules() : [];
}

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

export class DappfenceWebpackPlugin {
    constructor(opts, webpackOptions) {
        const { secretKey, ...publicOpts } = opts;
        this.opts = publicOpts;
        this._secretKey = secretKey || null;
        this.isServer = webpackOptions.isServer;
        this.isDev = webpackOptions.dev || false;
        this.nextConfig = webpackOptions.config || {};
        // Normalize basePath: strip trailing slash; empty string when absent.
        this._basePath = (this.nextConfig.basePath || '').replace(/\/$/, '');
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

            // SSR mode: copy dappfence.js eagerly, then write config for the
            // dappfence-next CLI. Use `"build": "next build && dappfence-next"`
            // (not postbuild — next build calls process.exit, skipping npm lifecycle).
            await this._copyDappfenceJs(compiler.context);
            await this._writeConfig({
                buildType: 'ssr',
                basePath: this._basePath,
                ...(this._secretKey && { secretKey: this._secretKey }),
            });
            console.log(
                'DappFence: SSR mode — use `"build": "dappfence-next build"` in package.json to generate the manifest.'
            );
        });
    }

    async _copyDappfenceJs(projectRoot) {
        const dappfenceJsPath = _require.resolve('@dappfence/core');
        const publicDir = path.join(projectRoot, 'public');
        await fs.mkdir(publicDir, { recursive: true });
        const destRel = this.opts.scriptSrc.replace(/^\//, '');
        const destAbs = path.join(publicDir, destRel);
        await fs.copyFile(dappfenceJsPath, destAbs);
        logger.info(`DappFence: copied dappfence.js → public/${destRel}`);
    }

    // Write build config (no secret key) for the dappfence-next CLI.
    // The CLI reads the signing key from DAPPFENCE_SECRET_KEY at runtime.
    async _writeConfig(extra = {}) {
        const configPath = path.join(this.projectRoot, '.next', 'dappfence-config.json');
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({ ...this.opts, ...extra }, null, 2), 'utf8');
    }
}

// Kept for any callers that import this directly (e.g. tests).
export { DEFAULT_PATH_RULES, buildContentRules, logger };
