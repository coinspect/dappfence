#!/usr/bin/env node
/**
 * dappfence-next — build wrapper + postbuild CLI for Next.js.
 *
 * Usage:
 *   "build": "dappfence-next build"    ← preferred: wraps next build
 *   "build": "next build && dappfence-next"  ← alternative: explicit chain
 *
 * In wrapper mode (`dappfence-next build`), spawns `next build` as a child
 * process. Because `next build` calls process.exit(0) internally, npm's
 * postbuild lifecycle never fires — but the parent process continues after
 * the child exits, so we can generate the manifest here.
 *
 * Supports two project types detected from the config written by the
 * webpack plugin during `next build`:
 *
 *   Static export (output: 'export'):
 *     1. Copies dappfence.js into the export output directory.
 *     2. Injects the dappfence script tag into every HTML file.
 *     3. Hashes all tracked files and writes integrity-manifest.json.
 *
 *   SSR (default Next.js mode):
 *     1. Hashes all files in .next/static/ (served at /_next/static/).
 *     2. Starts the built Next.js server programmatically and fetches every
 *        known URL twice — deterministic responses get body-hashed, per-request
 *        varying responses get CSP-only treatment. Parameterised routes are
 *        enumerated via generateStaticParams(); routes without enumeration are
 *        sentinel-probed for CSP hashes only.
 *     3. Writes integrity-manifest.json to public/.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDynamicRoutes, readPrerenderedRoutes } from '../src/routes.js';
import { hashPublicFiles, hashSSRRoutes, routePatternToPrefixKey } from '../src/ssr.js';

// Probe URL for the unmatched-route body. Anything not matching a real
// route → Next serves the /404 body (from _not-found.tsx or pages/404.tsx),
// which we key as '/404' in the manifest so the SW's error-page rule can
// verify unmatched-URL responses.
const NOT_FOUND_PROBE_URL = '/404';

const _require = createRequire(import.meta.url);
const { generateManifest, buildNetlifyContentRules, resolveNetlifyCdpHashes } = _require(
    '@dappfence/manifest-tools/manifest'
);
const resolveDappfenceJsPath = (scriptSrc) =>
    scriptSrc.endsWith('.dev.js')
        ? _require.resolve('@dappfence/core/dev')
        : _require.resolve('@dappfence/core');

const STATIC_EXPORT_PATH_RULES = [{ type: 'directory-index' }, { type: 'html-extension' }];

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
};

async function runSSR(opts, projectRoot) {
    const basePath = opts.basePath || '';
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(opts.netlify);
    const secretKey = process.env.DAPPFENCE_SECRET_KEY || opts.secretKey || null;

    const nextStaticDir = path.join(projectRoot, '.next', 'static');
    const publicDir = path.join(projectRoot, 'public');

    const nextStaticExists = await fs
        .stat(nextStaticDir)
        .then(() => true)
        .catch(() => false);
    if (!nextStaticExists) {
        logger.warn('DappFence: no .next/static directory found — did `next build` complete?');
        process.exit(1);
    }

    const [
        { allRoutes: dynamicRoutes, fixedRoutes, probedPatterns, isrRoutes },
        prerenderedRoutes,
        publicHashes,
        cdpHashes,
    ] = await Promise.all([
        readDynamicRoutes(projectRoot),
        readPrerenderedRoutes(projectRoot),
        hashPublicFiles(projectRoot, opts.manifestPath, basePath, logger),
        isNetlify ? resolveNetlifyCdpHashes(logger) : Promise.resolve(null),
    ]);

    // Feed every hashable URL through the single fetch-based pipeline. Includes:
    //   - prerenderedRoutes: pages + force-static route handlers from prerender
    //     manifest (deterministic bytes → body-hashed)
    //   - fixedRoutes: dynamic SSR pages/handlers with no URL params (double-fetch
    //     decides body hash vs CSP-only)
    //   - isrRoutes: ISR pages included so their CSP hashes are extracted; body
    //     hashes are dropped below because they go stale after the first
    //     revalidation cycle
    //   - NOT_FOUND_PROBE_URL: unmatched-route probe → Next serves the /404 body
    //     which gets keyed as /404 in the manifest for the SW's error-page rule
    // Deduped via Set — force-static route handlers can appear in both
    // prerenderedRoutes and fixedRoutes.
    const allFixedUrls = [
        ...new Set([...prerenderedRoutes, ...fixedRoutes, ...isrRoutes, NOT_FOUND_PROBE_URL]),
    ];
    const ssrResult = await hashSSRRoutes(projectRoot, allFixedUrls, probedPatterns, logger);

    // ISR routes are prerendered at build time but regenerated periodically.
    // The double-fetch determinism check succeeds within the build window but
    // the hash goes stale after the first revalidation cycle. Drop them from
    // bodyHashes; the contentRule loop below emits a `csp` action so the SW
    // serves ISR responses CSP-only.
    const isrPathSet = new Set(isrRoutes.map((r) => (basePath ? basePath + r : r)));
    if (isrPathSet.size > 0) {
        for (const route of isrRoutes) {
            logger.warn(
                `DappFence: ISR route ${route} (revalidate > 0) — body hash excluded from manifest; ` +
                    `enable dynamicRSC mode if this page embeds per-request data in RSC push scripts`
            );
        }
    }

    const extraHashes = {
        ...(cdpHashes && { '/.netlify/scripts/cdp': cdpHashes }),
        ...Object.fromEntries(
            Object.entries(ssrResult.bodyHashes).filter(([k]) => !isrPathSet.has(k))
        ),
        ...publicHashes,
    };
    // Each dynamic-route prefix becomes a contentRule with action `csp` so the SW
    // skips hash-verify for those routes (their content varies per request) while
    // still applying CSP. Prerendered pages have no matching rule and fall through
    // to the SW's default `verify`. csp.pages carries only the routes that produced
    // real inline hashes; empty entries would be indistinguishable from missing
    // and the SW defaults missing to empty.
    const completeCspPages = ssrResult.cspPages;
    const cspRules = [];
    const seenPrefixes = new Set();
    for (const route of dynamicRoutes) {
        const key = basePath
            ? basePath + routePatternToPrefixKey(route)
            : routePatternToPrefixKey(route);
        if (!seenPrefixes.has(key)) {
            seenPrefixes.add(key);
            cspRules.push({
                condition: { resourceTypes: ['document'], urlFilter: key },
                action: { type: 'csp' },
            });
        }
    }

    // ISR routes are prerendered at build but regenerated per revalidate window.
    // Body hashes were dropped above (isrPathSet filter) because they'd go stale on
    // the first revalidation. Emit a contentRule so the SW serves the response
    // CSP-only instead of falling through to `verify` and hitting NOT_FOUND.
    for (const route of isrRoutes) {
        const key = basePath ? basePath + route : route;
        if (!seenPrefixes.has(key)) {
            seenPrefixes.add(key);
            cspRules.push({
                condition: { resourceTypes: ['document'], urlFilter: key },
                action: { type: 'csp' },
            });
        }
    }

    const ssrPathRules = [{ type: 'directory-index' }];
    const notFoundUrl = extraHashes[basePath + '/404']
        ? basePath + '/404'
        : extraHashes['/404']
          ? '/404'
          : null;
    if (notFoundUrl) {
        ssrPathRules.push({ type: 'error-page', status: 404, url: notFoundUrl });
    }

    await generateManifest({
        outDir: nextStaticDir,
        manifestPath: path.relative(nextStaticDir, path.join(publicDir, opts.manifestPath)),
        pathPrefix: basePath + '/_next/static',
        exclude: opts.exclude,
        secretKey,
        mode: opts.mode,
        pathRules: ssrPathRules,
        contentRules: [...cspRules, ...(isNetlify ? buildNetlifyContentRules() : [])],
        scriptAttrs: null,
        logger,
        ...(Object.keys(extraHashes).length > 0 && { extraHashes }),
        ...(Object.keys(completeCspPages).length > 0 && { csp: { pages: completeCspPages } }),
    });

    logger.info(`DappFence: manifest written → public/${opts.manifestPath}`);
}

async function runStaticExport(opts, projectRoot) {
    const outDir = path.join(projectRoot, opts.distDir || 'out');

    const outDirExists = await fs
        .stat(outDir)
        .then(() => true)
        .catch(() => false);
    if (!outDirExists) {
        console.error(`DappFence: output directory not found: ${outDir}`);
        process.exit(1);
    }

    const destRel = opts.scriptSrc.replace(/^\//, '');
    const destAbs = path.join(outDir, destRel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(resolveDappfenceJsPath(opts.scriptSrc), destAbs);
    console.log(`DappFence: copied dappfence.js → ${destRel}`);

    const secretKey = process.env.DAPPFENCE_SECRET_KEY || null;
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(opts.netlify);
    const [{ allRoutes: dynamicRoutes }, cdpHashes] = await Promise.all([
        readDynamicRoutes(projectRoot),
        isNetlify ? resolveNetlifyCdpHashes(logger) : Promise.resolve(null),
    ]);

    // Static export usually has no dynamic routes, but readDynamicRoutes may
    // include rewrites or API routes. Emit `csp` rules for whatever it returns —
    // matches the SSR pipeline's treatment.
    const cspRules = [];
    const seenPrefixes = new Set();
    for (const route of dynamicRoutes) {
        const key = routePatternToPrefixKey(route);
        if (!seenPrefixes.has(key)) {
            seenPrefixes.add(key);
            cspRules.push({
                condition: { resourceTypes: ['document'], urlFilter: key },
                action: { type: 'csp' },
            });
        }
    }

    await generateManifest({
        outDir,
        manifestPath: opts.manifestPath,
        exclude: opts.exclude,
        secretKey,
        mode: opts.mode,
        pathRules: STATIC_EXPORT_PATH_RULES,
        contentRules: [...cspRules, ...(isNetlify ? buildNetlifyContentRules() : [])],
        scriptAttrs: opts,
        logger,
        ...(cdpHashes && { extraHashes: { '/.netlify/scripts/cdp': cdpHashes } }),
    });
}

async function generateManifestFromConfig(projectRoot) {
    const configPath = path.join(projectRoot, '.next', 'dappfence-config.json');

    let opts;
    try {
        opts = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch {
        console.error(
            'DappFence: could not read .next/dappfence-config.json — ' +
                'make sure withDappfence() is configured in next.config.js and next build has run.'
        );
        process.exit(1);
    }

    if (opts.buildType === 'ssr') {
        await runSSR(opts, projectRoot);
    } else {
        await runStaticExport(opts, projectRoot);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const projectRoot = process.cwd();

    if (args[0] === 'build') {
        // Wrapper mode: spawn next build as a child process, then generate the
        // manifest. next build calls process.exit(0) internally which would kill
        // a parent process only if we were using fork() — spawnSync is safe.
        // --import the preload so the RSC compile hook installs in every worker
        // Next forks during prerender. Env vars survive fork boundaries.
        const preloadUrl = pathToFileURL(_require.resolve('@dappfence/next/preload')).href;
        const priorNodeOptions = process.env.NODE_OPTIONS || '';
        const nodeOptions = `${priorNodeOptions} --import=${preloadUrl}`.trim();
        const result = spawnSync('next', ['build', ...args.slice(1)], {
            stdio: 'inherit',
            shell: process.platform === 'win32',
            env: { ...process.env, NODE_OPTIONS: nodeOptions },
        });
        if (result.status !== 0) {
            process.exit(result.status ?? 1);
        }
        await generateManifestFromConfig(projectRoot);
    } else {
        // Postbuild mode: next build already ran, just generate the manifest.
        await generateManifestFromConfig(projectRoot);
    }
}

main().catch((err) => {
    console.error('DappFence:', err.message);
    process.exit(1);
});
