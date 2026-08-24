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
 * Script tag (add to your root layout):
 *
 *   import { getDappfenceScriptAttrs } from '@dappfence/next';
 *   const attrs = getDappfenceScriptAttrs();
 *   // Next.js: <Script strategy="beforeInteractive" {...attrs} />
 *   // React:   <script {...attrs} />
 */
import { createRequire } from 'node:module';
import { DappfenceWebpackPlugin } from './webpack-plugin.js';

const _require = createRequire(import.meta.url);
const { deriveIdentity } = _require('@dappfence/manifest-tools');
const { buildScriptAttrs } = _require('@dappfence/manifest-tools/manifest');

const DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
    mode: 'protected',
    appSW: null,
    warningUrl: null,
    manifestPath: 'integrity-manifest.json',
    exclude: [],
};

// Internal env var name used to pass script attrs through the Next.js build.
export const ATTRS_ENV_KEY = '_DAPPFENCE_SCRIPT_ATTRS';

export function withDappfence(options = {}) {
    const opts = { ...DEFAULTS, ...options };

    opts.secretKey = opts.secretKey || process.env.DAPPFENCE_SECRET_KEY || null;

    if (opts.secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(opts.secretKey);
    }

    // Bake only the public-safe script attrs into the Next.js build.
    // secretKey must never appear here — it would be emitted into all JS bundles.
    const {
        scriptSrc,
        manifestUrl,
        manifestSignatureType,
        manifestSignatureIdentity,
        appSW,
        warningUrl,
    } = opts;
    const attrsJson = JSON.stringify({
        scriptSrc,
        manifestUrl,
        manifestSignatureType,
        manifestSignatureIdentity: manifestSignatureIdentity || null,
        appSW,
        warningUrl,
    });

    // next.config.js runs in the server process at startup, so this persists for the
    // entire runtime. DefinePlugin (used by Next.js env) only patches app-bundle code,
    // not node_modules — so getDappfenceScriptAttrs() would always see undefined without this.
    process.env[ATTRS_ENV_KEY] = attrsJson;

    return function (nextConfig = {}) {
        return {
            ...nextConfig,
            env: {
                ...nextConfig.env,
                [ATTRS_ENV_KEY]: attrsJson,
            },
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

/**
 * Returns the <script> attributes for the dappfence script tag.
 * Reads from the value baked into the build by withDappfence — no private key needed.
 *
 * @param {object} [overrides] - Optional overrides applied on top of the baked config.
 */
export function getDappfenceScriptAttrs(overrides = {}) {
    try {
        const stored = JSON.parse(process.env[ATTRS_ENV_KEY] || 'null');
        if (!stored) throw new Error('not set');
        return buildScriptAttrs({ ...stored, ...overrides });
    } catch {
        console.warn(
            'DappFence: script attrs not found. ' +
                'Make sure withDappfence() is configured in next.config.js.'
        );
        return buildScriptAttrs(overrides);
    }
}
