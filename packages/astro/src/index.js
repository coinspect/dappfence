/**
 * @dappfence/astro — Astro integration
 *
 * Usage in astro.config.mjs:
 *
 *   import dappfence from '@dappfence/astro';
 *
 *   export default defineConfig({
 *     integrations: [
 *       dappfence({
 *         secretKey: process.env.DAPPFENCE_SECRET_KEY,
 *       }),
 *     ],
 *   });
 *
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateManifest } from './manifest.js';

const _require = createRequire(import.meta.url);
const { deriveIdentity } = _require('@dappfence/manifest-tools');
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

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

export default function dappfence(options = {}) {
    // Separate the signing key from public opts so it never contaminates
    // serialised output or script attributes.
    const { secretKey: explicitKey, ...publicOptions } = options;
    const opts = { ...DEFAULTS, ...publicOptions };

    const secretKey = explicitKey || process.env.DAPPFENCE_SECRET_KEY || null;

    // Derive the signer identity from secretKey so users don't have to supply it.
    if (secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(secretKey);
    }

    // Captured in astro:routes:resolved (Astro 6 moved routes out of build:done).
    let resolvedRoutes = [];

    return {
        name: '@dappfence/astro',
        hooks: {
            'astro:config:setup'({ logger }) {
                if (!secretKey) {
                    logger.error(
                        'DappFence: secretKey is required. ' +
                            'Pass it via the integration option or set the DAPPFENCE_SECRET_KEY environment variable.'
                    );
                    throw new Error('[@dappfence/astro] secretKey is required');
                }
            },

            // Fires after Astro resolves all routes (dev and build).
            // Captures the route list so astro:build:done can record dynamic
            // (non-pre-rendered) routes in the manifest metadata.
            'astro:routes:resolved'({ routes }) {
                resolvedRoutes = routes;
            },

            // Production build only. After Astro has written all HTML files to
            // disk, this hook:
            //   1. Copies dappfence.js from @dappfence/core to outDir so it is
            //      served at the path declared in scriptSrc (default /dappfence.js).
            //   2. Injects the script tag into every HTML file (Astro's SSG
            //      pipeline writes files directly, bypassing Vite's HTML pipeline).
            //   3. Hashes every tracked file (JS, CSS, HTML, …).
            //   4. Signs and writes integrity-manifest.json to the output dir.
            async 'astro:build:done'({ dir, pages, logger }) {
                const outDir = fileURLToPath(dir);

                const destRel = opts.scriptSrc.replace(/^\//, '');
                const destAbs = path.join(outDir, destRel);
                await fs.mkdir(path.dirname(destAbs), { recursive: true });
                await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
                logger.info(`DappFence: copied dappfence.js → ${destRel}`);

                await generateManifest({
                    ...opts,
                    secretKey,
                    outDir,
                    pages,
                    routes: resolvedRoutes,
                    scriptAttrs: opts,
                    logger,
                });
            },
        },
    };
}
