import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const _require = createRequire(import.meta.url);
const { extractInlineHashesFromHtml } = _require('@dappfence/manifest-tools/inline-scripts');

export function routePatternToProbeUrl(pattern) {
    return pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, '__probe__')
        .replace(/\[([^\]]+)\]/g, '__probe__');
}

export function routePatternToPrefixKey(pattern) {
    const firstBracket = pattern.indexOf('[');
    if (firstBracket === -1) return pattern;
    const prefix = pattern.slice(0, pattern.lastIndexOf('/', firstBracket) + 1);
    return prefix || '/';
}

// Substitute a params object into a route pattern. Handles [id] and [...slug].
// Returns null if any required param is missing from the object.
export function substitutePatternParams(pattern, paramsObj) {
    let missing = false;
    const url = pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, (_, key) => {
            const v = paramsObj[key];
            if (v === undefined) {
                missing = true;
                return '';
            }
            return Array.isArray(v) ? v.map(encodeURIComponent).join('/') : encodeURIComponent(v);
        })
        .replace(/\[([^\]]+)\]/g, (_, key) => {
            const v = paramsObj[key];
            if (v === undefined) {
                missing = true;
                return '';
            }
            return encodeURIComponent(v);
        });
    return missing ? null : url;
}

// Load the compiled route/page module for a pattern and call
// generateStaticParams() if the userland exports it. Returns an array of
// concrete URLs (already substituted) or [] if the route doesn't enumerate.
// The Next runtime must already be prepared — the compiled module requires
// `next/dist/...` internals that only resolve after app.prepare().
async function enumerateConcreteUrls(projectRoot, pattern) {
    const patternDir = pattern.slice(1); // strip leading '/'
    for (const kind of ['route', 'page']) {
        const modulePath = path.join(
            projectRoot,
            '.next',
            'server',
            'app',
            patternDir,
            `${kind}.js`
        );
        let compiled;
        try {
            const moduleRequire = createRequire(modulePath);
            compiled = moduleRequire(modulePath);
        } catch {
            continue;
        }
        const gsp = compiled?.routeModule?.userland?.generateStaticParams;
        if (typeof gsp !== 'function') continue;
        const params = await gsp();
        if (!Array.isArray(params)) return [];
        const urls = [];
        for (const p of params) {
            const url = substitutePatternParams(pattern, p);
            if (url !== null) urls.push(url);
        }
        return urls;
    }
    return [];
}

function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

/**
 * Start the built Next.js SSR server on a random port, fetch each fixedRoute
 * (twice, to detect per-request variance), and enumerate each probedPattern
 * via generateStaticParams() to hash concrete URLs. Returns body hashes for
 * deterministic responses and inline-script CSP hashes for HTML responses.
 * The server is closed after all routes are processed.
 *
 * fixedRoutes  — Concrete URLs to fetch. Includes prerendered pages, force-
 *                static route handlers, dynamic SSR pages, dynamic route
 *                handlers, and the /404 probe. The double-fetch determinism
 *                check decides whether each gets a body hash (stable bytes)
 *                or CSP-only treatment (varying bytes).
 * probedPatterns — Parameterised routes (contain '['). For each, try to
 *                  import the compiled module and call generateStaticParams();
 *                  if it enumerates, hash each concrete URL like fixedRoutes.
 *                  If it doesn't enumerate, sentinel-probe once for CSP hashes
 *                  only (body is per-request and not stored).
 *
 * @param {string}   projectRoot    - Absolute path to the Next.js project root.
 * @param {string[]} fixedRoutes    - Concrete web paths to fetch (e.g. ['/', '/about', '/404'])
 * @param {string[]} probedPatterns - Route patterns with '[' params (e.g. ['/blog/[slug]'])
 * @param {object}   logger
 * @returns {Promise<{ bodyHashes: Record<string,string>, cspPages: Record<string,object> }>}
 */
export async function hashSSRRoutes(projectRoot, fixedRoutes, probedPatterns, logger) {
    if (!fixedRoutes.length && !probedPatterns.length) {
        return { bodyHashes: {}, cspPages: {} };
    }

    let app, nextHandler;
    try {
        // Resolve `next` relative to projectRoot so symlinked packages find the
        // user's installed copy rather than resolving from this file's real path.
        const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
        const nextPath = projectRequire.resolve('next');
        const { default: next } = await import(pathToFileURL(nextPath).href);
        app = next({ dev: false, dir: projectRoot });
        await app.prepare();
        nextHandler = app.getRequestHandler();
    } catch (err) {
        logger.warn(
            `DappFence: could not start Next.js programmatic server — ${err.message}; skipping SSR route hashing`
        );
        return { bodyHashes: {}, cspPages: {} };
    }

    const server = createServer((req, res) => nextHandler(req, res));
    const port = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.once('error', reject);
    });

    const bodyHashes = {};
    const cspPages = {};

    // Fetch a URL twice and return { buf, deterministic }. The double-fetch
    // is the sole basis for deciding whether a route body can be hashed —
    // it catches request-varying content (Date.now(), counters, headers()
    // reads) even on routes declared static, and validates that "declared
    // dynamic + enumerated params" routes are actually stable per URL.
    async function fetchDeterministic(webPath) {
        const [r1, r2] = await Promise.all([
            fetch(`http://127.0.0.1:${port}${webPath}`),
            fetch(`http://127.0.0.1:${port}${webPath}`),
        ]);
        const [b1, b2] = await Promise.all([r1.arrayBuffer(), r2.arrayBuffer()]);
        const buf1 = Buffer.from(b1);
        const buf2 = Buffer.from(b2);
        return {
            buf: buf1,
            deterministic: buf1.equals(buf2),
            status: r1.status,
            ok: r1.ok,
            finalPath: new URL(r1.url).pathname,
            contentType: r1.headers.get('content-type') ?? '',
        };
    }

    function extractCsp(pathKey, buf, contentType, label) {
        if (!contentType.includes('text/html')) return;
        try {
            const { scripts, attrs, warnings } = extractInlineHashesFromHtml(buf.toString('utf8'));
            for (const w of warnings) {
                logger.warn(`DappFence: ${label}: ${w}`);
            }
            if (scripts.length || attrs.length) {
                cspPages[pathKey] = {
                    ...(scripts.length && { scripts }),
                    ...(attrs.length && { attrs }),
                };
            }
        } catch (err) {
            logger.warn(`DappFence: CSP hash extraction failed for ${label}: ${err.message}`);
        }
    }

    // Process one concrete URL: fetch twice, body-hash if bytes are stable,
    // and always attempt CSP hash extraction. Used for both fixedRoutes and
    // enumerated concrete URLs from probedPatterns.
    async function hashConcreteUrl(webPath, source) {
        try {
            const r = await fetchDeterministic(webPath);
            if (r.buf.length === 0) {
                logger.warn(
                    `DappFence: ${source} ${webPath} returned empty body (HTTP ${r.status}); skipping`
                );
                return;
            }
            const statusNote = r.ok ? '' : ` (HTTP ${r.status})`;
            if (r.deterministic) {
                bodyHashes[r.finalPath] = sriHash(r.buf);
                logger.info(
                    `DappFence: hashed ${source} ${webPath}${r.finalPath !== webPath ? ` → ${r.finalPath}` : ''}${statusNote}`
                );
            } else {
                logger.info(
                    `DappFence: ${source} ${webPath} bytes vary across requests — CSP-only, no body hash${statusNote}`
                );
            }
            extractCsp(r.finalPath, r.buf, r.contentType, r.finalPath);
        } catch (err) {
            logger.warn(
                `DappFence: failed to probe ${source} ${webPath} — ${err.message}; skipping`
            );
        }
    }

    try {
        for (const webPath of fixedRoutes) {
            await hashConcreteUrl(webPath, 'SSR route');
        }

        // Enumerate each parameterised route: import its compiled module and
        // call generateStaticParams(). Each enumerated concrete URL flows
        // through the same deterministic-fetch pipeline as fixedRoutes.
        // Track which patterns had enumerated coverage so the sentinel probe
        // below only fires for patterns with no enumeration.
        const enumeratedPatterns = new Set();
        for (const pattern of probedPatterns) {
            let concreteUrls;
            try {
                concreteUrls = await enumerateConcreteUrls(projectRoot, pattern);
            } catch (err) {
                logger.warn(
                    `DappFence: enumeration failed for ${pattern} — ${err.message}; falling back to sentinel probe`
                );
                continue;
            }
            if (concreteUrls.length === 0) continue;
            enumeratedPatterns.add(pattern);
            logger.info(
                `DappFence: enumerated ${pattern} → ${concreteUrls.length} concrete URL(s)`
            );
            for (const webPath of concreteUrls) {
                await hashConcreteUrl(webPath, `enumerated ${pattern}`);
            }
        }

        // Fallback: sentinel-probe each remaining pattern once — extract CSP
        // hashes only (no body hash, since the sentinel is a made-up value
        // whose response bytes have no meaning at runtime).
        const probedPrefixes = new Set();
        for (const pattern of probedPatterns) {
            if (enumeratedPatterns.has(pattern)) continue;
            const prefixKey = routePatternToPrefixKey(pattern);
            if (probedPrefixes.has(prefixKey)) continue;
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
                extractCsp(prefixKey, buf, contentType, `${pattern} (probe)`);
                if (cspPages[prefixKey]) {
                    const { scripts = [], attrs = [] } = cspPages[prefixKey];
                    logger.info(
                        `DappFence: probed ${pattern} → CSP prefix ${prefixKey} (${scripts.length} script, ${attrs.length} attr hash(es))`
                    );
                } else {
                    logger.info(`DappFence: probed ${pattern} — no inline scripts found`);
                }
            } catch (err) {
                logger.warn(`DappFence: probe failed for ${pattern} — ${err.message}; skipping`);
            }
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
        try {
            await app.close();
        } catch {
            // app.close() is not available in all Next.js versions
        }
    }

    return { bodyHashes, cspPages };
}

/**
 * Hash all files in public/ and return a { webPath → sriHash } map.
 * These are served at the root URL and must be in the manifest so the SW
 * can verify them (dappfence.js, favicons, robots.txt, etc.).
 * Excludes the manifest file itself.
 *
 * @param {string} projectRoot
 * @param {string} manifestFileName - filename of the manifest to exclude (e.g. 'integrity-manifest.json')
 * @param {string} basePath
 * @param {object} logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashPublicFiles(projectRoot, manifestFileName, basePath, logger) {
    const publicDir = path.join(projectRoot, 'public');
    const hashes = {};

    async function walk(dir) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(abs);
            } else if (entry.isFile()) {
                const rel = path.relative(publicDir, abs);
                // Skip the manifest file — it's bootstrapped separately
                if (rel === manifestFileName) continue;
                const urlPath = (basePath || '') + '/' + rel.replace(/\\/g, '/');
                const buf = await fs.readFile(abs);
                hashes[urlPath] = sriHash(buf);
                logger.info(`DappFence: hashed public file ${urlPath}`);
            }
        }
    }

    await walk(publicDir);
    return hashes;
}
