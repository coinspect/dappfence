/**
 * @dappfence/next — Next.js integration
 *
 * Usage in next.config.js (SSR / hybrid):
 *
 *   import { withDappfence } from '@dappfence/next';
 *
 *   export default withDappfence({
 *     secretKey: process.env.DAPPFENCE_SECRET_KEY,
 *   })(nextConfig);
 *
 * Usage for static export (output: 'export'), add to package.json:
 *
 *   "scripts": {
 *     "build": "next build",
 *     "postbuild": "dappfence-next"
 *   }
 *
 * Script tag (add to your root layout or _document.js):
 *
 *   import { buildScriptAttrs } from '@dappfence/manifest-tools/manifest';
 *   // React: <script {...buildScriptAttrs(opts)} />
 *   // Vue:   <script v-bind="buildScriptAttrs(opts)" />
 */
import { createRequire } from 'node:module';
import { DappfenceWebpackPlugin } from './webpack-plugin.js';

const _require = createRequire(import.meta.url);
const { deriveIdentity } = _require('@dappfence/manifest-tools');

const DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
    mode: 'protected',
    appSW: null,
    warningUrl: null,
    manifestPath: 'integrity-manifest.json',
    extensions: null,
    exclude: [],
};

export function withDappfence(options = {}) {
    const opts = { ...DEFAULTS, ...options };

    opts.secretKey = opts.secretKey || process.env.DAPPFENCE_SECRET_KEY || null;

    if (opts.secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(opts.secretKey);
    }

    return function (nextConfig = {}) {
        return {
            ...nextConfig,
            webpack(config, webpackOptions) {
                config.plugins.push(new DappfenceWebpackPlugin(opts, webpackOptions));

                if (typeof nextConfig.webpack === 'function') {
                    return nextConfig.webpack(config, webpackOptions);
                }
                return config;
            },
        };
    };
}
