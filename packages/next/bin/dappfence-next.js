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
 *     2. Reads pre-rendered HTML from .next/server/{app,pages}/ and hashes them.
 *     3. Writes integrity-manifest.json to public/.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readDynamicRoutes } from '../src/routes.js';
import { hashPrerenderedPages, hashPublicFiles } from '../src/ssr.js';

const _require = createRequire(import.meta.url);
const { generateManifest, buildNetlifyContentRules, resolveNetlifyCdpHashes } = _require(
    '@dappfence/manifest-tools/manifest'
);
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

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

    const [dynamicRoutes, pageHashes, publicHashes, cdpHashes] = await Promise.all([
        readDynamicRoutes(projectRoot),
        hashPrerenderedPages(projectRoot, basePath, logger),
        hashPublicFiles(projectRoot, opts.manifestPath, basePath, logger),
        isNetlify ? resolveNetlifyCdpHashes(logger) : Promise.resolve(null),
    ]);
    const extraHashes = {
        ...(cdpHashes && { '/.netlify/scripts/cdp': cdpHashes }),
        ...pageHashes,
        ...publicHashes,
    };

    const ssrPathRules = [{ type: 'directory-index' }];
    const notFoundKey = extraHashes[basePath + '/404']
        ? basePath + '/404'
        : extraHashes['/404']
          ? '/404'
          : null;
    if (notFoundKey) {
        ssrPathRules.push({ type: 'not-found', fallback: notFoundKey });
    }

    await generateManifest({
        outDir: nextStaticDir,
        manifestPath: path.relative(nextStaticDir, path.join(publicDir, opts.manifestPath)),
        pathPrefix: basePath + '/_next/static',
        exclude: opts.exclude,
        secretKey,
        mode: opts.mode,
        dynamicRoutes: dynamicRoutes.map((r) => (basePath ? basePath + r : r)),
        pathRules: ssrPathRules,
        contentRules: isNetlify ? buildNetlifyContentRules() : [],
        scriptAttrs: null,
        logger,
        ...(Object.keys(extraHashes).length > 0 && { extraHashes }),
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
    await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
    console.log(`DappFence: copied dappfence.js → ${destRel}`);

    const secretKey = process.env.DAPPFENCE_SECRET_KEY || null;
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(opts.netlify);
    const [dynamicRoutes, cdpHashes] = await Promise.all([
        readDynamicRoutes(projectRoot),
        isNetlify ? resolveNetlifyCdpHashes(logger) : Promise.resolve(null),
    ]);

    await generateManifest({
        outDir,
        manifestPath: opts.manifestPath,
        exclude: opts.exclude,
        secretKey,
        mode: opts.mode,
        dynamicRoutes,
        pathRules: STATIC_EXPORT_PATH_RULES,
        contentRules: isNetlify ? buildNetlifyContentRules() : [],
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
        const result = spawnSync('next', ['build', ...args.slice(1)], {
            stdio: 'inherit',
            shell: process.platform === 'win32',
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
