import { promises as fs } from 'node:fs';
import path from 'node:path';

async function readJson(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads Next.js build manifests and returns URL patterns that must be treated
 * as dynamic (skipped during hash verification):
 *
 *  - Rewrite source patterns — proxied to another destination, not hashable
 *  - Dynamic route pages (e.g. /blog/[slug]) — rendered per-request
 *  - SSR-only pages — rendered per-request (not in the prerender manifest)
 *
 * Returns an object with four lists:
 *  - allRoutes: all dynamic URL patterns (superset)
 *  - fixedRoutes: SSR-only pages with no URL params — can be fetched and hashed
 *  - probedPatterns: parameterised routes (contain '[') — probe with a sentinel value
 *  - isrRoutes: prerendered routes with initialRevalidateSeconds > 0 — body hash
 *    becomes stale after the first revalidation cycle and must be excluded from
 *    manifest.files
 *
 * Rewrite patterns (contain ':') proxy to external origins and are excluded from
 * both fixedRoutes and probedPatterns — they can never be fetched at build time.
 *
 * @param {string} projectRoot - Absolute path to the Next.js project root.
 * @returns {Promise<{ allRoutes: string[], fixedRoutes: string[], probedPatterns: string[], isrRoutes: string[] }>}
 */
export async function readDynamicRoutes(projectRoot) {
    const nextDir = path.join(projectRoot, '.next');

    const [routesManifest, prerenderManifest, pagesManifest, appPathsManifest] = await Promise.all([
        readJson(path.join(nextDir, 'routes-manifest.json')),
        readJson(path.join(nextDir, 'prerender-manifest.json')),
        readJson(path.join(nextDir, 'server', 'pages-manifest.json')),
        readJson(path.join(nextDir, 'server', 'app-paths-manifest.json')),
    ]);

    if (!routesManifest)
        return { allRoutes: [], fixedRoutes: [], probedPatterns: [], isrRoutes: [] };

    const patterns = new Set();

    // --- Rewrites ---
    // Source URLs are proxied to another destination and cannot be hashed at
    // build time. Handle both the flat array form (older Next.js) and the
    // { beforeFiles, afterFiles, fallback } object form (Next.js 10+).
    const rewrites = routesManifest.rewrites ?? [];
    if (Array.isArray(rewrites)) {
        for (const r of rewrites) if (r.source) patterns.add(r.source);
    } else {
        for (const r of rewrites.beforeFiles ?? []) if (r.source) patterns.add(r.source);
        for (const r of rewrites.afterFiles ?? []) if (r.source) patterns.add(r.source);
        for (const r of rewrites.fallback ?? []) if (r.source) patterns.add(r.source);
    }

    // --- Dynamic route pages (e.g. /blog/[slug]) ---
    // These have parameterised URLs and are rendered per-request.
    for (const r of routesManifest.dynamicRoutes ?? []) if (r.page) patterns.add(r.page);

    // --- SSR-only pages ---
    // Any page that exists in the pages/app manifests but is NOT in the
    // prerender manifest is server-rendered on every request and cannot be
    // hashed at build time.
    const prerendered = new Set([
        ...Object.keys(prerenderManifest?.routes ?? {}),
        ...Object.keys(prerenderManifest?.dynamicRoutes ?? {}),
    ]);

    // Pages Router pages — keys are already URL paths (e.g. "/dashboard").
    for (const page of Object.keys(pagesManifest ?? {})) {
        // Skip internal Next.js pages.
        if (page.startsWith('/_')) continue;
        if (!prerendered.has(page)) patterns.add(page);
    }

    // App Router pages — keys use the file-system convention (e.g. "/dashboard/page").
    // Normalize to URL paths by stripping the trailing "/page" segment.
    for (const appPath of Object.keys(appPathsManifest ?? {})) {
        if (!appPath.endsWith('/page')) continue;
        const urlPath = appPath.slice(0, -'/page'.length) || '/';
        if (!prerendered.has(urlPath)) patterns.add(urlPath);
    }

    // App Router API route handlers — keys end in "/route" (e.g. "/api/version/route").
    // These are request handlers that produce dynamic responses; they have no HTML
    // on disk and can never be content-hashed at build time.
    for (const appPath of Object.keys(appPathsManifest ?? {})) {
        if (!appPath.endsWith('/route')) continue;
        const urlPath = appPath.slice(0, -'/route'.length) || '/';
        patterns.add(urlPath);
    }

    const allRoutes = [...patterns];

    // ISR routes: prerendered at build time but regenerated periodically.
    // Their body hash is valid only until the first revalidation cycle; after that
    // the on-disk HTML diverges from what the server serves. Callers should drop
    // body hashes for these routes to avoid false-positive tamper alerts.
    const isrRoutes = Object.entries(prerenderManifest?.routes ?? {})
        .filter(([, meta]) => meta.initialRevalidateSeconds !== false)
        .map(([path]) => path);

    const fixedRoutes = [];
    const probedPatterns = [];
    for (const route of allRoutes) {
        if (route.includes('[')) {
            probedPatterns.push(route);
        } else if (!route.includes(':')) {
            // Rewrites use ':param' syntax and proxy to external origins — don't fetch them.
            fixedRoutes.push(route);
        }
    }

    return { allRoutes, fixedRoutes, probedPatterns, isrRoutes };
}

/**
 * Read Next's prerender-manifest.json and return the list of prerendered
 * concrete URLs — pages and force-static route handlers whose response bytes
 * are deterministic across requests. ISR routes (initialRevalidateSeconds > 0)
 * are excluded because their body hash goes stale after the first revalidation
 * cycle.
 *
 * These URLs feed the unified fetch-based hashing pipeline. The programmatic
 * Next server serves them with the same bytes as the on-disk .html/.body
 * files, so fetching is equivalent to walking .next/server/ but robust to
 * Next's internal layout changes.
 *
 * @param {string} projectRoot
 * @returns {Promise<string[]>}
 */
export async function readPrerenderedRoutes(projectRoot) {
    const prerenderManifest = await readJson(
        path.join(projectRoot, '.next', 'prerender-manifest.json')
    );
    if (!prerenderManifest) return [];
    return Object.entries(prerenderManifest.routes ?? {})
        .filter(([, meta]) => meta.initialRevalidateSeconds === false)
        .map(([urlPath]) => urlPath);
}
