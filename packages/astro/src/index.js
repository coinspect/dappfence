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
    extractFixedRoutes,
    extractEnumerableRoutes,
    extractProbedPatterns,
    hashSSRRoutes,
    sriHash,
} from './manifest.js';
import { dappfenceAttrsPlugin } from './inject/attrs-virtual-plugin.js';

const _require = createRequire(import.meta.url);
const { deriveIdentity } = _require('@dappfence/manifest-tools');
const { buildScriptTag } = _require('@dappfence/manifest-tools/manifest');

const MIDDLEWARE_URL = new URL('./inject/middleware.js', import.meta.url);

const SERVER_ISLANDS_TARGET_SUFFIX = '/astro/dist/runtime/server/render/server-islands.js';
const SUBCLASS_SOURCE_URL = new URL('./inject/server-island-subclass.js', import.meta.url);

// Replaces Astro's ServerIslandComponent with a subclass that emits per-request
// island data as an inert <script type="application/json"> plus two static
// scripts (Astro's SERVER_ISLAND_REPLACER + our listener) in <head>. This makes
// every executable script on the page hash-stable at build time — the whole
// island machinery collapses to two CSP hashes shared across all pages.
//
// Concatenation strategy: the subclass source is appended into the target
// module verbatim so it inherits the module-local identifiers it depends on
// (SERVER_ISLAND_REPLACER, markHTMLString, encryptString, …). The export line
// is rewritten so `ServerIslandComponent` resolves to our subclass everywhere
// downstream.
function serverIslandPatchPlugin() {
    return {
        name: 'dappfence:patch-server-islands',
        enforce: 'post',
        async load(id) {
            if (!id.endsWith(SERVER_ISLANDS_TARGET_SUFFIX)) {
                return null;
            }
            const subclassSource = await fs.readFile(fileURLToPath(SUBCLASS_SOURCE_URL), 'utf8');
            const orig = await fs.readFile(id, 'utf8');
            const exportRe = /export\s*\{\s*ServerIslandComponent[\s\S]*?\};\s*$/;
            if (!exportRe.test(orig)) {
                throw new Error(
                    '[@dappfence/astro] server-islands.js export block not found — Astro version may be incompatible'
                );
            }
            return orig.replace(
                exportRe,
                subclassSource +
                    '\nexport { DfServerIslandComponent as ServerIslandComponent, containsServerDirective, renderServerIslandRuntime };\n'
            );
        },
    };
}

const resolveDappfenceJsPath = (scriptSrc) =>
    scriptSrc.endsWith('.dev.js')
        ? _require.resolve('@dappfence/core/dev')
        : _require.resolve('@dappfence/core');

const DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
    mode: 'protected',
    appSW: null,
    warningUrl: null,
    manifestPath: 'integrity-manifest.json',
    exclude: [],
    patchServerIslands: true,
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
    // Populated by astro:build:ssr — route.pattern → absolute compiled chunk path.
    const ssrRouteToChunk = new Map();

    return {
        name: '@dappfence/astro',
        hooks: {
            'astro:config:setup'({ logger, config, updateConfig, addMiddleware }) {
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

                const scriptTag = buildScriptTag(opts);
                const vitePlugins = [dappfenceAttrsPlugin(scriptTag)];
                if (opts.patchServerIslands) {
                    vitePlugins.push(serverIslandPatchPlugin());
                }
                updateConfig({ vite: { plugins: vitePlugins } });

                addMiddleware({
                    entrypoint: MIDDLEWARE_URL,
                    order: 'pre',
                });
            },

            // Fires after Astro resolves all routes (dev and build).
            // Captures the route list so astro:build:done can record dynamic
            // (non-pre-rendered) routes in the manifest metadata.
            'astro:routes:resolved'({ routes }) {
                resolvedRoutes = routes;
            },

            // Astro populates entryModules (from Vite's generateBundle) with
            // virtual:astro:page:<component>@_@<ext> → chunks/<file>.mjs. This
            // gives us an authoritative source-component → compiled-chunk map,
            // avoiding basename ambiguity when multiple routes share a filename
            // (e.g. /partials/[id], /partials/dynamic/[id], /api/item/[id] all
            // compile to _id__*.mjs). route.file is documented but is always ""
            // at this point in the pipeline — do not rely on it.
            'astro:build:ssr'({ manifest }) {
                const buildServerDir = manifest.buildServerDir;
                for (const route of manifest.routes || []) {
                    const component = route.routeData?.component;
                    const pattern = route.routeData?.route;
                    if (!component || !pattern) {
                        continue;
                    }
                    // Vite's virtual-module convention prefixes every key with a
                    // literal null byte. Astro's normalizeEntryId only strips
                    // '\0astro-entry:', so 'virtual:astro:page:...' keeps its \0.
                    const virtualKey = `\0virtual:astro:page:${component.replace(/\.([^.]+)$/, '@_@$1')}`;
                    const chunkFile = manifest.entryModules?.[virtualKey];
                    if (!chunkFile) {
                        continue;
                    }
                    const abs = fileURLToPath(new URL(chunkFile, buildServerDir));
                    ssrRouteToChunk.set(pattern, abs);
                }
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
                await fs.copyFile(resolveDappfenceJsPath(opts.scriptSrc), destAbs);
                logger.info(`DappFence: copied dappfence.js → ${destRel}`);

                // Hash the copied file and add explicitly to extraHashes so it is
                // always in the manifest under the exact scriptSrc URL. Also exclude
                // it from the walk so stale dappfence build files in outDir cannot
                // appear in the manifest under the wrong key.
                const scriptSrcWebKey = (resolvedBase || '') + opts.scriptSrc;
                const dappfenceScriptHash = sriHash(await fs.readFile(destAbs));

                const scriptHash = { [scriptSrcWebKey]: dappfenceScriptHash };
                let extraHashes = null;
                let cspPages = null;
                // config.build.server is set by the adapter after astro:config:setup runs,
                // so fall back to the conventional sibling server/ directory.
                const serverDir = resolvedServerDir ?? path.join(path.dirname(outDir), 'server');
                const entryMjsPath = path.join(serverDir, 'entry.mjs');
                const entryExists = await fs
                    .access(entryMjsPath)
                    .then(() => true)
                    .catch(() => false);

                const fixedRoutes = extractFixedRoutes(resolvedRoutes);
                const { patterns: enumerablePatterns, paths: enumerableRoutes } = entryExists
                    ? await extractEnumerableRoutes(resolvedRoutes, ssrRouteToChunk, logger)
                    : { patterns: [], paths: [] };
                const prefixRoute = resolvedBase ? (r) => resolvedBase + r : (r) => r;
                const allSSRRoutes = [...fixedRoutes, ...enumerableRoutes].map(prefixRoute);
                const probedPatterns = extractProbedPatterns(resolvedRoutes).map(prefixRoute);

                if (allSSRRoutes.length || probedPatterns.length) {
                    if (entryExists) {
                        logger.info(
                            `DappFence: hashing ${fixedRoutes.length} fixed, ${enumerableRoutes.length} enumerable SSR route(s)${probedPatterns.length ? `, probing ${probedPatterns.length} probed pattern(s)` : ''} via ${path.relative(path.dirname(outDir), entryMjsPath)}`
                        );
                        // Only enumerable routes get byte-hashes recorded — their
                        // getStaticPaths() contract implies deterministic content
                        // per param, so byte-hash is enforceable at runtime. Fixed
                        // SSR routes are declared dynamic by prerender=false and
                        // the runtime SW skips verify for them via the csp rule,
                        // so their byte-hash would be dead weight.
                        const byteHashPaths = new Set(enumerableRoutes.map(prefixRoute));
                        const result = await hashSSRRoutes(
                            entryMjsPath,
                            allSSRRoutes,
                            logger,
                            probedPatterns,
                            byteHashPaths
                        );
                        extraHashes = result.bodyHashes;
                        cspPages = result.cspPages;
                    } else {
                        logger.warn(
                            'DappFence: SSR routes found but no server/entry.mjs detected; add an SSR adapter to hash them'
                        );
                    }
                }

                await generateManifest({
                    ...opts,
                    // Exclude the dappfence script from the walk — it is added
                    // explicitly via extraHashes above so only the configured
                    // scriptSrc URL appears in the manifest.
                    exclude: [...(opts.exclude || []), scriptSrcWebKey],
                    secretKey,
                    outDir,
                    pages,
                    routes: resolvedRoutes,
                    buildFormat: resolvedBuildFormat,
                    base: resolvedBase,
                    scriptAttrs: opts,
                    logger,
                    extraHashes: { ...scriptHash, ...(extraHashes || {}) },
                    enumerablePatterns,
                    ...(cspPages && Object.keys(cspPages).length > 0 && { cspPages }),
                });
            },
        },
    };
}
