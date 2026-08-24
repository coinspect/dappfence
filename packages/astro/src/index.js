/**
 * @dappfence/astro — Astro integration
 *
 * Usage in astro.config.mjs:
 *
 *   import dappfence from '@dappfence/astro';
 *
 *   export default defineConfig({
 *     integrations: [
 *       mdx(),
 *       sitemap(),
 *       // dappfence must be listed last — its astro:build:done hook walks and hashes
 *       // the output directory, so all integrations that write files must run first.
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
import {
    generateManifest,
    extractTier1Routes,
    extractTier2Routes,
    hashSSRRoutes,
} from './manifest.js';

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
    let resolvedBuildFormat = 'directory';
    let resolvedServerDir = null;
    // Normalized base path (e.g. '/my-app'); empty string when site is at root.
    let resolvedBase = '';

    return {
        name: '@dappfence/astro',
        hooks: {
            'astro:config:setup'({ logger, config }) {
                if (!secretKey) {
                    logger.error(
                        'DappFence: secretKey is required. ' +
                            'Pass it via the integration option or set the DAPPFENCE_SECRET_KEY environment variable.'
                    );
                    throw new Error('[@dappfence/astro] secretKey is required');
                }
                resolvedBuildFormat = config.build?.format ?? 'directory';
                if (config.build?.server) {
                    resolvedServerDir = fileURLToPath(config.build.server);
                }
                // Normalize base: strip trailing slash; treat '/' as no prefix.
                const rawBase = config.base ?? '/';
                resolvedBase = rawBase === '/' ? '' : rawBase.replace(/\/$/, '');
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

                let extraHashes = null;
                // config.build.server is set by the adapter after astro:config:setup runs,
                // so fall back to the conventional sibling server/ directory.
                const serverDir = resolvedServerDir ?? path.join(path.dirname(outDir), 'server');
                const entryMjsPath = path.join(serverDir, 'entry.mjs');
                const entryExists = await fs
                    .access(entryMjsPath)
                    .then(() => true)
                    .catch(() => false);

                const tier1Routes = extractTier1Routes(resolvedRoutes);
                const tier2Routes = entryExists
                    ? await extractTier2Routes(resolvedRoutes, serverDir, logger)
                    : [];
                const prefixRoute = resolvedBase ? (r) => resolvedBase + r : (r) => r;
                const allSSRRoutes = [...tier1Routes, ...tier2Routes].map(prefixRoute);

                if (allSSRRoutes.length) {
                    if (entryExists) {
                        logger.info(
                            `DappFence: hashing ${tier1Routes.length} Tier-1, ${tier2Routes.length} Tier-2 SSR route(s) via ${path.relative(path.dirname(outDir), entryMjsPath)}`
                        );
                        extraHashes = await hashSSRRoutes(entryMjsPath, allSSRRoutes, logger);
                    } else {
                        logger.warn(
                            'DappFence: SSR routes found but no server/entry.mjs detected; add an SSR adapter to hash them'
                        );
                    }
                }

                await generateManifest({
                    ...opts,
                    secretKey,
                    outDir,
                    pages,
                    routes: resolvedRoutes,
                    buildFormat: resolvedBuildFormat,
                    base: resolvedBase,
                    scriptAttrs: opts,
                    logger,
                    ...(extraHashes && { extraHashes }),
                });
            },
        },
    };
}
