/**
 * @dappfence/vite — Vite plugin
 *
 * Usage in vite.config.js:
 *
 *   import dappfence from '@dappfence/vite';
 *
 *   export default defineConfig({
 *     plugins: [
 *       react(),
 *       // dappfence should be listed last — its closeBundle hook walks and
 *       // hashes the output directory, so plugins that write extra files
 *       // into outDir must run first.
 *       dappfence({
 *         secretKey: process.env.DAPPFENCE_SECRET_KEY,
 *       }),
 *     ],
 *   });
 *
 * Scope: plain Vite SPA/MPA builds with static HTML output. Meta-frameworks
 * built on Vite (Astro, Next.js, SvelteKit, Nuxt, Remix, …) have their own
 * output layout and SSR routes and are not covered here — use
 * @dappfence/astro or @dappfence/next for those.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    calculateFileHash,
    deriveIdentity,
    SUPPORTED_SIGNATURE_TYPES,
} from '@dappfence/manifest-tools';
import { generateManifest } from '@dappfence/manifest-tools/manifest';

const resolveDappfenceJsPath = (scriptSrc) =>
    fileURLToPath(
        import.meta.resolve(
            scriptSrc.endsWith('.dev.js') ? '@dappfence/core/dev' : '@dappfence/core'
        )
    );

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

const DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
    manifestPath: 'integrity-manifest.json',
    mode: 'protected',
    appSW: null,
    warningUrl: null,
    exclude: [],
    // Extensionless routes (e.g. '/btc') copied from spaFallbackSource into
    // outDir before hashing. Solves static hosts that lack a catch-all
    // rewrite to index.html for a client-side router: the copies get the
    // bootstrap script tag injected and are tracked in the manifest exactly
    // like any other page, with no separate postbuild `cp` step required.
    spaFallback: [],
    spaFallbackSource: 'index.html',
};

export default function dappfence(options = {}) {
    // Separate the signing key from public opts so it never contaminates
    // serialised output or script attributes.
    const { secretKey: explicitKey, ...publicOptions } = options;
    const opts = { ...DEFAULTS, ...publicOptions };

    // signManifest only ever produces one signature type — a manifest signed
    // with a manifestSignatureType this package can't actually sign would
    // declare a different type in the script tag than the one the manifest
    // was really signed with, and the SW would reject it as an unsupported
    // or mismatched signature.
    if (!SUPPORTED_SIGNATURE_TYPES.includes(opts.manifestSignatureType)) {
        throw new Error(
            `[@dappfence/vite] manifestSignatureType "${opts.manifestSignatureType}" is not ` +
                `supported by the build-time signer (supported: ${SUPPORTED_SIGNATURE_TYPES.join(', ')}).`
        );
    }

    const secretKey = explicitKey || process.env.DAPPFENCE_SECRET_KEY || null;

    // Derive the signer identity from secretKey so users don't have to supply it.
    if (secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(secretKey);
    }

    let resolvedOutDir;
    // Normalized base path (e.g. '/my-app'); empty string when site is at root.
    let resolvedBase = '';

    return {
        name: '@dappfence/vite',
        apply: 'build',
        enforce: 'post',

        configResolved(config) {
            if (!secretKey) {
                throw new Error(
                    '[@dappfence/vite] secretKey is required. ' +
                        'Pass it via the plugin option or set the DAPPFENCE_SECRET_KEY environment variable.'
                );
            }
            resolvedOutDir = path.resolve(config.root, config.build.outDir);
            const rawBase = config.base ?? '/';
            resolvedBase = rawBase === '/' ? '' : rawBase.replace(/\/$/, '');
        },

        // Fires after Vite has written the build output to disk. This:
        //   1. Copies dappfence.js from @dappfence/core into outDir at scriptSrc.
        //   2. Writes any configured SPA-fallback route copies.
        //   3. Injects the script tag into every page (main HTML + fallbacks),
        //      hashes every tracked file, signs, and writes the manifest.
        async closeBundle() {
            const outDir = resolvedOutDir;

            const destRel = opts.scriptSrc.replace(/^\//, '');
            const destAbs = path.join(outDir, destRel);
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            await fs.copyFile(resolveDappfenceJsPath(opts.scriptSrc), destAbs);
            logger.info(`DappFence: copied dappfence.js → ${destRel}`);

            // Hash the copied file and add explicitly to extraHashes so it is
            // always in the manifest under the exact scriptSrc URL, and exclude
            // it from the walk so a stale dappfence build file in outDir cannot
            // appear in the manifest under the wrong key.
            const scriptSrcWebKey = resolvedBase + opts.scriptSrc;
            const scriptHash = calculateFileHash(await fs.readFile(destAbs));

            const fallbackWebPaths = new Set();
            if (opts.spaFallback.length) {
                const sourceAbs = path.join(outDir, opts.spaFallbackSource);
                const sourceHtml = await fs.readFile(sourceAbs, 'utf8');
                for (const route of opts.spaFallback) {
                    const rel = route.replace(/^\//, '');
                    const targetAbs = path.join(outDir, rel);
                    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
                    await fs.writeFile(targetAbs, sourceHtml, 'utf8');
                    fallbackWebPaths.add(resolvedBase + route);
                }
                logger.info(
                    `DappFence: wrote ${opts.spaFallback.length} SPA-fallback route(s) from ${opts.spaFallbackSource}`
                );
            }

            // Default page matching is extension-based (.html/.htm); fallback
            // routes are extensionless, so they're matched explicitly by web
            // path. Passing an explicit pageFilter overrides this entirely.
            const pageFilter =
                opts.pageFilter ||
                ((webPath, ext) =>
                    ext === '.html' || ext === '.htm' || fallbackWebPaths.has(webPath));

            await generateManifest({
                outDir,
                manifestPath: opts.manifestPath,
                exclude: [...opts.exclude, scriptSrcWebKey],
                secretKey,
                mode: opts.mode,
                pathRules: opts.pathRules,
                contentRules: opts.contentRules,
                pageFilter,
                // The injected <script> tag's src/data-manifest must be resolved
                // against the site's base path too, or the browser requests them
                // at the domain root instead of where the build is actually
                // deployed (config.base) — see resolvedBase above.
                scriptAttrs: {
                    ...opts,
                    scriptSrc: resolvedBase + opts.scriptSrc,
                    manifestUrl: opts.manifestUrl && resolvedBase + opts.manifestUrl,
                },
                logger,
                extraHashes: { [scriptSrcWebKey]: scriptHash },
                pathPrefix: resolvedBase,
                csp: opts.csp,
            });
        },
    };
}
