import { createRequire } from 'node:module';
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
const { extractInlineHashesFromHtml } = _require('@dappfence/manifest-tools/inline-scripts');

export { buildScriptAttrs, buildScriptTag, injectScriptTag };

/**
 * Generate a probe URL from a route pattern by substituting every parameter
 * segment with a sentinel value. The probe is fetched at build time to extract
 * stable inline script hashes without requiring concrete IDs.
 *
 * @param {string} pattern - e.g. '/partials/dynamic/[id]'
 * @returns {string} - e.g. '/partials/dynamic/__probe__'
 */
export function routePatternToProbeUrl(pattern) {
    return pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, '__probe__')
        .replace(/\[([^\]]+)\]/g, '__probe__');
}

/**
 * Derive the prefix key used to store probe CSP hashes in the manifest.
 * Strips everything from the first parameter segment onward, keeping the
 * leading path up to and including the last '/' before that segment.
 *
 * @param {string} pattern - e.g. '/partials/dynamic/[id]'
 * @returns {string} - e.g. '/partials/dynamic/'
 */
export function routePatternToPrefixKey(pattern) {
    const firstBracket = pattern.indexOf('[');
    if (firstBracket === -1) return pattern;
    const prefix = pattern.slice(0, pattern.lastIndexOf('/', firstBracket) + 1);
    return prefix || '/';
}

/**
 * Extract probedRoute patterns — SSR routes with URL parameters.
 * These cannot be fetched for a body hash (IDs are not enumerable), but can
 * be probed with a sentinel value to extract stable inline script CSP hashes.
 * Includes routes that also have getStaticPaths (enumerableRoute); the probe provides
 * a prefix-based fallback for any IDs not covered by the enumeration.
 *
 * @param {object[]} routes - Astro resolved routes
 * @returns {string[]} route patterns
 */
export function extractProbedPatterns(routes) {
    if (!routes?.length) return [];
    return routes
        .filter(
            (r) =>
                !r.isPrerendered &&
                r.type !== 'redirect' &&
                r.params?.length > 0 &&
                !r.pattern?.startsWith('/_')
        )
        .map((r) => r.pattern)
        .filter(Boolean);
}

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
 * Extract fixedRoute SSR routes — SSR with no URL parameters.
 * These have a fixed URL and a deterministic response body, so they can be
 * fetched and hashed at build time without any param enumeration.
 */
export function extractFixedRoutes(routes) {
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
 * Extract enumerableRoute SSR routes — parameterized SSR routes that export getStaticPaths().
 * Imports each route's compiled chunk (looked up in the astro:build:ssr map),
 * calls getStaticPaths(), and builds the concrete web paths to hash.
 *
 * @param {object[]}          routes    - Astro resolved routes
 * @param {Map<string,string>} chunkMap  - route.pattern → absolute compiled chunk path
 * @param {object}            logger    - Astro integration logger
 * @returns {Promise<{ patterns: string[], paths: string[] }>}
 *   patterns: route.pattern strings that were successfully enumerated
 *   paths:    concrete web paths for the SSR builder to fetch and hash
 */
export async function extractEnumerableRoutes(routes, chunkMap, logger) {
    if (!routes?.length) {
        return { patterns: [], paths: [] };
    }

    const candidates = routes.filter(
        (r) =>
            !r.isPrerendered &&
            r.type !== 'redirect' &&
            r.params?.length > 0 &&
            typeof r.entrypoint === 'string'
    );

    if (!candidates.length) {
        return { patterns: [], paths: [] };
    }

    const patterns = [];
    const paths = [];
    for (const route of candidates) {
        const chunkPath = chunkMap?.get(route.pattern);
        if (!chunkPath) {
            logger.warn(
                `DappFence: no compiled chunk found for ${route.pattern}; skipping enumerableRoute hashing`
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
                `DappFence: could not import chunk for ${route.pattern} — ${err.message}; skipping`
            );
            continue;
        }

        if (typeof pageModule?.getStaticPaths !== 'function') {
            continue;
        }

        let staticPaths;
        try {
            staticPaths = await pageModule.getStaticPaths();
        } catch (err) {
            logger.warn(
                `DappFence: getStaticPaths() failed for ${route.pattern} — ${err.message}; skipping`
            );
            continue;
        }

        if (!Array.isArray(staticPaths)) {
            continue;
        }

        let addedForThisRoute = false;
        for (const { params } of staticPaths) {
            let webPath = route.pattern;
            for (const [key, value] of Object.entries(params)) {
                webPath = webPath.replace(`[...${key}]`, value).replace(`[${key}]`, value);
            }
            if (webPath && !webPath.includes('[')) {
                paths.push(webPath);
                addedForThisRoute = true;
            }
        }
        if (addedForThisRoute) {
            patterns.push(route.pattern);
        }
    }

    return { patterns, paths };
}

export function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

/**
 * Start the built Astro SSR server on a random port, fetch each fixedRoute,
 * and return a { webPath → sriHash } map. The server is closed after all routes
 * are fetched.
 *
 * @param {string}      entryMjsPath - Absolute path to the compiled entry.mjs
 * @param {string[]}    routes       - Web paths to fetch (fixed + enumerable)
 * @param {object}      logger       - Astro integration logger
 * @param {string[]}    [probedPatterns] - Route patterns to probe once with a sentinel URL
 * @param {Set<string>} [byteHashPaths]  - Subset of `routes` for which the body hash
 *                                         should be recorded in bodyHashes. Routes not in
 *                                         this set still have CSP hashes extracted but no
 *                                         byte-hash — appropriate for fixed SSR routes
 *                                         whose response varies per request (the runtime
 *                                         SW skips verify for them via the csp contentRule,
 *                                         so a recorded byte-hash is dead weight).
 * @returns {Promise<{ bodyHashes: Record<string,string>, cspPages: Record<string,object> }>}
 */
export async function hashSSRRoutes(
    entryMjsPath,
    routes,
    logger,
    probedPatterns = [],
    byteHashPaths = null
) {
    if (!routes.length && !probedPatterns.length) return { bodyHashes: {}, cspPages: {} };

    process.env.ASTRO_NODE_AUTOSTART = 'disabled';
    let handler;
    try {
        const mod = await import(entryMjsPath);
        handler = mod.handler;
    } catch (err) {
        logger.warn(`DappFence: could not import SSR entry — ${err.message}; skipping SSR hashing`);
        return { bodyHashes: {}, cspPages: {} };
    } finally {
        delete process.env.ASTRO_NODE_AUTOSTART;
    }

    if (typeof handler !== 'function') {
        logger.warn('DappFence: SSR entry did not export a handler function; skipping SSR hashing');
        return { bodyHashes: {}, cspPages: {} };
    }

    const server = createServer(handler);
    const port = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.once('error', reject);
    });

    const bodyHashes = {};
    const cspPages = {};
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
                const shouldRecordBodyHash = byteHashPaths === null || byteHashPaths.has(webPath);
                if (shouldRecordBodyHash) {
                    bodyHashes[finalPath] = sriHash(buf);
                }
                const statusNote = res.ok ? '' : ` (HTTP ${res.status})`;
                const action = shouldRecordBodyHash ? 'hashed' : 'probed';
                logger.info(
                    `DappFence: ${action} SSR route ${webPath}${finalPath !== webPath ? ` → ${finalPath}` : ''}${statusNote}`
                );
                const contentType = res.headers.get('content-type') ?? '';
                if (contentType.includes('text/html')) {
                    try {
                        const { scripts, attrs, warnings } = extractInlineHashesFromHtml(
                            buf.toString('utf8')
                        );
                        for (const w of warnings) {
                            logger.warn(`DappFence: ${finalPath}: ${w}`);
                        }
                        if (scripts.length || attrs.length) {
                            cspPages[finalPath] = {
                                ...(scripts.length && { scripts }),
                                ...(attrs.length && { attrs }),
                            };
                        }
                    } catch (err) {
                        logger.warn(
                            `DappFence: CSP hash extraction failed for ${finalPath}: ${err.message}`
                        );
                    }
                }
            } catch (err) {
                logger.warn(
                    `DappFence: failed to hash SSR route ${webPath} — ${err.message}; skipping`
                );
            }
        }

        // probedRoute: probe each unique prefix once with a sentinel URL.
        // Only CSP hashes are extracted — body hash is discarded (content is dynamic).
        const probedPrefixes = new Set();
        for (const pattern of probedPatterns) {
            const prefixKey = routePatternToPrefixKey(pattern);
            if (probedPrefixes.has(prefixKey)) {
                continue;
            }
            probedPrefixes.add(prefixKey);

            const probeUrl = routePatternToProbeUrl(pattern);
            try {
                const res = await fetch(`http://127.0.0.1:${port}${probeUrl}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    logger.warn(`DappFence: probe ${pattern} returned empty body; skipping`);
                    continue;
                }
                const contentType = res.headers.get('content-type') ?? '';
                if (!contentType.includes('text/html')) {
                    logger.warn(
                        `DappFence: probe ${pattern} returned non-HTML (${contentType}); skipping`
                    );
                    continue;
                }
                try {
                    const { scripts, attrs, warnings } = extractInlineHashesFromHtml(
                        buf.toString('utf8')
                    );
                    for (const w of warnings) {
                        logger.warn(`DappFence: ${pattern} (probe): ${w}`);
                    }
                    if (scripts.length || attrs.length) {
                        cspPages[prefixKey] = {
                            ...(scripts.length && { scripts }),
                            ...(attrs.length && { attrs }),
                        };
                        logger.info(
                            `DappFence: probed ${pattern} → CSP prefix ${prefixKey} (${scripts.length} script, ${attrs.length} attr hash(es))`
                        );
                    } else {
                        logger.info(`DappFence: probed ${pattern} — no inline scripts found`);
                    }
                } catch (err) {
                    logger.warn(
                        `DappFence: CSP hash extraction failed for probe ${pattern}: ${err.message}`
                    );
                }
            } catch (err) {
                logger.warn(`DappFence: probe failed for ${pattern} — ${err.message}; skipping`);
            }
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    return { bodyHashes, cspPages };
}

export function buildPageSet(pages) {
    const set = new Set();
    for (const { pathname } of pages) {
        // Normalize: ensure a single leading slash and strip the trailing slash.
        // Astro emits pathname with a trailing slash and inconsistently with or
        // without a leading slash depending on version — this normalizes both
        // shapes to the leading-slash form the walk uses when it emits webPath.
        const base = ('/' + pathname).replace(/\/+/g, '/').replace(/\/$/, '');
        set.add(base ? `${base}/index.html` : '/index.html');
        if (base) set.add(`${base}.html`);
    }
    return set;
}

/**
 * Resolve the manifest URL to map a given HTTP error status to, from build output.
 * Preference order per status:
 *   1. SSR-hashed route in extraHashes (from hashSSRRoutes) — trailing slash first
 *   2. Prerendered static page in pages array — Astro convention `/{status}.html`
 *   3. SSR route registered in routes but not fetched (e.g. 500.astro typical case)
 *
 * Astro emits `404.astro` (and `500.astro` if prerendered) to `dist/client/{status}.html`
 * regardless of `build.format` — special case so static hosts can pick them up at the
 * root. The disk walk always keys those under `/{status}.html`, not `/{status}/index.html`.
 * Returns null when no page for `status` is in the build output.
 */
function resolveErrorPageUrl(
    status,
    { base = '', extraHashes = null, pages = null, routes = null, cspPages = null }
) {
    const s = String(status);
    // Byte-hashed SSR route (from hashSSRRoutes bodyHashes) — trailing slash first.
    if (extraHashes?.[base + '/' + s + '/']) {
        return base + '/' + s + '/';
    }
    if (extraHashes?.[base + '/' + s]) {
        return base + '/' + s;
    }
    // Prerendered — Astro emits {status}.html at the root regardless of build.format.
    if (pages?.some((p) => p.pathname === s + '/' || p.pathname === '/' + s + '/')) {
        return base + '/' + s + '.html';
    }
    // SSR route with an inline-script CSP entry — prefer the trailing-slash form
    // (Astro's `trailingSlash: 'always'` canonicalizes fetches to /X/). This matches
    // where hashSSRRoutes actually stored the extracted script hashes.
    if (
        cspPages?.[base + '/' + s + '/']?.scripts?.length ||
        cspPages?.[base + '/' + s + '/']?.attrs?.length
    ) {
        return base + '/' + s + '/';
    }
    if (cspPages?.[base + '/' + s]?.scripts?.length || cspPages?.[base + '/' + s]?.attrs?.length) {
        return base + '/' + s;
    }
    // SSR route registered but not fetched (typical for 500.astro before this
    // integration fetches it): default to the trailing-slash form because Astro
    // canonicalizes to that when `trailingSlash: 'always'` is set. When the site
    // uses a different trailingSlash policy, csp.pages entries above will match
    // first and pick the correct variant.
    if (
        routes?.some(
            (r) => !r.isPrerendered && (r.pattern === '/' + s || r.pattern === '/' + s + '/')
        )
    ) {
        return base + '/' + s + '/';
    }
    return null;
}

/**
 * Resolve `error-page` pathRule entries for every HTTP status that has a
 * matching page in the build output. Currently detects 404 and 500.
 *
 * @returns {Array<{ status: number, url: string }>}
 */
export function resolveErrorPageRules(ctx = {}) {
    const rules = [];
    for (const status of [404, 500]) {
        const url = resolveErrorPageUrl(status, ctx);
        if (url) {
            rules.push({ status, url });
        }
    }
    return rules;
}

/**
 * Build pathRules based on Astro's output format.
 * 'directory' (default) → directory-index; 'file' → html-extension.
 *
 * `errorPageRules` is an array of { status, url } entries emitted verbatim as
 * `{ type: 'error-page', status, url }` after the base rule. Empty means no
 * error page was detected in the build.
 */
export function buildPathRules(buildFormat, errorPageRules = []) {
    const rules = [];
    if (buildFormat === 'file') {
        rules.push({ type: 'html-extension' });
    } else {
        rules.push({ type: 'directory-index' });
    }
    for (const { status, url } of errorPageRules) {
        rules.push({ type: 'error-page', status, url });
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
    cspPages,
    base = '',
    netlify = false,
    logger,
    enumerablePatterns = [],
    ...rest
}) {
    const prefixRoute = base ? (r) => base + r : (r) => r;
    const pageSet = pages?.length ? buildPageSet(pages) : null;
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(netlify);

    const errorPageRules = resolveErrorPageRules({ base, extraHashes, pages, routes, cspPages });

    const cdpHashes = isNetlify ? await resolveNetlifyCdpHashes(logger) : null;
    const mergedExtraHashes = {
        ...(cdpHashes && { '/.netlify/scripts/cdp': cdpHashes }),
        ...(extraHashes || {}),
    };

    // Each dynamic-route prefix becomes a contentRule with action `csp` so the SW
    // skips hash-verify for those routes (their content varies per request) while
    // still applying CSP. Static prerendered pages have no matching rule and fall
    // through to the SW's default `verify`.
    //
    // Enumerable routes (getStaticPaths + prerender=false) are the exception:
    // hashSSRRoutes has recorded byte-hashes for each concrete URL, so we want
    // the SW to enforce `verify` on those URLs rather than skip to CSP. Excluding
    // their prefix from cspRules lets the byte-hash win at runtime (and prevents
    // the prefix from shadowing a prerendered sibling like /partials/prerendered/).
    //
    // csp.pages entries are added only where hashSSRRoutes produced real inline
    // hashes; routes without any inline scripts contribute nothing (the SW
    // defaults missing entries to empty).
    const enumerablePrefixSet = new Set(
        enumerablePatterns.map((p) => prefixRoute(routePatternToPrefixKey(p)))
    );
    const cspRules = [];
    const seenPrefixes = new Set();
    for (const route of extractDynamicRoutes(routes)) {
        const key = prefixRoute(routePatternToPrefixKey(route));
        if (!seenPrefixes.has(key) && !enumerablePrefixSet.has(key)) {
            seenPrefixes.add(key);
            cspRules.push({
                condition: { resourceTypes: ['document'], urlFilter: key },
                action: { type: 'csp' },
            });
        }
    }

    return _generateManifest({
        ...rest,
        logger,
        pathRules: buildPathRules(buildFormat, errorPageRules),
        contentRules: [...cspRules, ...buildContentRules({ isNetlify })],
        // walk() generates keys as base + '/...' when pathPrefix is set; strip the
        // prefix before comparing against pageSet (which is built from page pathnames
        // without the base).
        pageFilter: pageSet
            ? (webPath) => pageSet.has(base ? webPath.slice(base.length) : webPath)
            : undefined,
        pathPrefix: base,
        ...(Object.keys(mergedExtraHashes).length > 0 && { extraHashes: mergedExtraHashes }),
        ...(cspPages && Object.keys(cspPages).length > 0 && { csp: { pages: cspPages } }),
    });
}
