import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const _require = createRequire(import.meta.url);
const {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    generateManifest: _generateManifest,
    buildNetlifyContentRules,
    resolveNetlifyCdpHashes,
} = _require('@dappfence/manifest-tools/manifest');

export { buildScriptAttrs, buildScriptTag, injectScriptTag };

/**
 * Extract server-rendered route patterns from the Astro routes array.
 * Routes not marked isPrerendered are SSR (pages, server islands, API routes).
 */
export function extractDynamicRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter((r) => !r.isPrerendered)
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Extract Tier 1 SSR routes — SSR with no URL parameters.
 * These have a fixed URL and a deterministic response body, so they can be
 * fetched and hashed at build time without any param enumeration.
 */
export function extractTier1Routes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter(
            (r) =>
                !r.isPrerendered &&
                r.type !== 'redirect' &&
                (!r.params || r.params.length === 0) &&
                !r.pattern?.startsWith('/_')
        )
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Find the Vite-compiled server chunk for a given source component.
 * Vite normalizes special characters ([ ]) to underscores in chunk filenames.
 */
async function findRouteChunk(serverDir, componentPath) {
    const basename = path.basename(componentPath, path.extname(componentPath));
    const normalized = basename.replace(/[[\]]/g, '_');
    const chunksDir = path.join(serverDir, 'chunks');
    let entries;
    try {
        entries = await fs.readdir(chunksDir);
    } catch {
        return null;
    }
    const match = entries.find(
        (e) => e.endsWith('.mjs') && (e.startsWith(normalized + '_') || e === normalized + '.mjs')
    );
    return match ? path.join(chunksDir, match) : null;
}

/**
 * Extract Tier 2 SSR routes — parameterized SSR routes that export getStaticPaths().
 * Imports each route's compiled chunk, calls getStaticPaths(), and uses route.generate()
 * to build the concrete web paths to hash.
 *
 * @param {object[]} routes    - Astro resolved routes
 * @param {string}   serverDir - Absolute path to the compiled server directory
 * @param {object}   logger    - Astro integration logger
 * @returns {Promise<string[]>}
 */
export async function extractTier2Routes(routes, serverDir, logger) {
    if (!routes?.length) return [];

    const candidates = routes.filter(
        (r) =>
            !r.isPrerendered &&
            r.type !== 'redirect' &&
            r.params?.length > 0 &&
            typeof r.entrypoint === 'string'
    );

    if (!candidates.length) return [];

    const results = [];
    for (const route of candidates) {
        const chunkPath = await findRouteChunk(serverDir, route.entrypoint);
        if (!chunkPath) {
            logger.warn(
                `DappFence: no compiled chunk found for ${route.entrypoint}; skipping Tier-2 hashing`
            );
            continue;
        }

        let pageModule;
        try {
            const mod = await import(chunkPath);
            // Astro compiles pages to export a `page` factory; call it to get the module object.
            pageModule = typeof mod.page === 'function' ? mod.page() : mod;
        } catch (err) {
            logger.warn(
                `DappFence: could not import chunk for ${route.entrypoint} — ${err.message}; skipping`
            );
            continue;
        }

        if (typeof pageModule?.getStaticPaths !== 'function') continue;

        let staticPaths;
        try {
            staticPaths = await pageModule.getStaticPaths();
        } catch (err) {
            logger.warn(
                `DappFence: getStaticPaths() failed for ${route.entrypoint} — ${err.message}; skipping`
            );
            continue;
        }

        if (!Array.isArray(staticPaths)) continue;

        for (const { params } of staticPaths) {
            let webPath = route.pattern;
            for (const [key, value] of Object.entries(params)) {
                webPath = webPath.replace(`[...${key}]`, value).replace(`[${key}]`, value);
            }
            if (webPath && !webPath.includes('[')) results.push(webPath);
        }
    }

    return results;
}

function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

/**
 * Start the built Astro SSR server on a random port, fetch each Tier 1 route,
 * and return a { webPath → sriHash } map. The server is closed after all routes
 * are fetched.
 *
 * @param {string}   entryMjsPath - Absolute path to the compiled entry.mjs
 * @param {string[]} routes       - Web paths to fetch and hash (e.g. ['/api/version.json'])
 * @param {object}   logger       - Astro integration logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashSSRRoutes(entryMjsPath, routes, logger) {
    if (!routes.length) return {};

    process.env.ASTRO_NODE_AUTOSTART = 'disabled';
    let handler;
    try {
        const mod = await import(entryMjsPath);
        handler = mod.handler;
    } catch (err) {
        logger.warn(`DappFence: could not import SSR entry — ${err.message}; skipping SSR hashing`);
        return {};
    } finally {
        delete process.env.ASTRO_NODE_AUTOSTART;
    }

    if (typeof handler !== 'function') {
        logger.warn('DappFence: SSR entry did not export a handler function; skipping SSR hashing');
        return {};
    }

    const server = createServer(handler);
    const port = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.once('error', reject);
    });

    const hashes = {};
    try {
        for (const webPath of routes) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}${webPath}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    logger.warn(
                        `DappFence: SSR route ${webPath} returned empty body (HTTP ${res.status}); skipping`
                    );
                    continue;
                }
                const finalPath = new URL(res.url).pathname;
                hashes[finalPath] = sriHash(buf);
                const statusNote = res.ok ? '' : ` (HTTP ${res.status})`;
                logger.info(
                    `DappFence: hashed SSR route ${webPath}${finalPath !== webPath ? ` → ${finalPath}` : ''}${statusNote}`
                );
            } catch (err) {
                logger.warn(
                    `DappFence: failed to hash SSR route ${webPath} — ${err.message}; skipping`
                );
            }
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    return hashes;
}

export function buildPageSet(pages) {
    const set = new Set();
    for (const { pathname } of pages) {
        const base = pathname.replace(/\/$/, '');
        set.add(base ? `${base}/index.html` : '/index.html');
        if (base) set.add(`${base}.html`);
    }
    return set;
}

/**
 * Build pathRules based on Astro's output format.
 * 'directory' (default) → directory-index; 'file' → html-extension.
 */
export function buildPathRules(buildFormat, notFoundKey = null) {
    const rules = [];
    if (buildFormat === 'file') {
        rules.push({ type: 'html-extension' });
    } else {
        rules.push({ type: 'directory-index' });
    }
    if (notFoundKey) {
        rules.push({ type: 'not-found', fallback: notFoundKey });
    }
    return rules;
}

/**
 * Build contentRules for this deployment environment.
 * Netlify injects a CDP snippet into served HTML; strip it before hashing,
 * and verify (then rewrite) the CDP script itself.
 */
export function buildContentRules({ isNetlify = false } = {}) {
    return isNetlify ? buildNetlifyContentRules() : [];
}

export async function generateManifest({
    pages,
    routes,
    buildFormat,
    extraHashes,
    base = '',
    netlify = false,
    logger,
    ...rest
}) {
    const prefixRoute = base ? (r) => base + r : (r) => r;
    const dynamicRoutes = extractDynamicRoutes(routes).map(prefixRoute);
    const pageSet = pages?.length ? buildPageSet(pages) : null;
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(netlify);

    // Determine the not-found fallback key for the `not-found` pathRule.
    // Prefer the SSR-hashed 404 page; fall back to the prerendered static 404.
    // extraHashes keys are already prefixed with base (from hashSSRRoutes response URLs).
    const notFoundKey = extraHashes?.[base + '/404/']
        ? base + '/404/'
        : extraHashes?.[base + '/404']
          ? base + '/404'
          : pages?.some((p) => p.pathname === '404/' || p.pathname === '/404/')
            ? base + (buildFormat === 'file' ? '/404.html' : '/404/index.html')
            : null;

    const cdpHashes = isNetlify ? await resolveNetlifyCdpHashes(logger) : null;
    const mergedExtraHashes = {
        ...(cdpHashes && { '/.netlify/scripts/cdp': cdpHashes }),
        ...(extraHashes || {}),
    };

    return _generateManifest({
        ...rest,
        logger,
        dynamicRoutes,
        pathRules: buildPathRules(buildFormat, notFoundKey),
        contentRules: buildContentRules({ isNetlify }),
        // walk() generates keys as base + '/...' when pathPrefix is set; strip the
        // prefix before comparing against pageSet (which is built from page pathnames
        // without the base).
        pageFilter: pageSet
            ? (webPath) => pageSet.has(base ? webPath.slice(base.length) : webPath)
            : undefined,
        pathPrefix: base,
        ...(Object.keys(mergedExtraHashes).length > 0 && { extraHashes: mergedExtraHashes }),
    });
}
