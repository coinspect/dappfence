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
 * @param {string} projectRoot - Absolute path to the Next.js project root.
 * @returns {Promise<string[]>}
 */
export async function readDynamicRoutes(projectRoot) {
    const nextDir = path.join(projectRoot, '.next');

    const [routesManifest, prerenderManifest, pagesManifest, appPathsManifest] = await Promise.all([
        readJson(path.join(nextDir, 'routes-manifest.json')),
        readJson(path.join(nextDir, 'prerender-manifest.json')),
        readJson(path.join(nextDir, 'server', 'pages-manifest.json')),
        readJson(path.join(nextDir, 'server', 'app-paths-manifest.json')),
    ]);

    if (!routesManifest) return [];

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

    return [...patterns];
}
