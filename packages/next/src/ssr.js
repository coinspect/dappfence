import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

function htmlFileToUrlPath(relPath) {
    const noExt = relPath.replace(/\.html$/, '');
    const urlPath = '/' + noExt.replace(/\\/g, '/');
    return urlPath === '/index' ? '/' : urlPath;
}

async function walkHtmlFiles(dir, baseDir, hashes, logger) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkHtmlFiles(abs, baseDir, hashes, logger);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            const rel = path.relative(baseDir, abs);
            const base = path.basename(rel);
            // Skip Next.js internal pages (_not-found, _error, _document, _app)
            if (base.startsWith('_')) continue;
            const urlPath = htmlFileToUrlPath(rel);
            const buf = await fs.readFile(abs);
            hashes[urlPath] = sriHash(buf);
            logger.info(`DappFence: hashed pre-rendered page ${urlPath}`);
        }
    }
}

/**
 * Read pre-rendered HTML files written by `next build` and return a
 * { webPath → sriHash } map. Covers App Router (○ / ●) and Pages Router
 * pages. Requires no server — the files are already on disk after build.
 *
 * @param {string} projectRoot
 * @param {string} basePath  - Optional Next.js basePath prefix (e.g. '/app')
 * @param {object} logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashPrerenderedPages(projectRoot, basePath, logger) {
    const serverDir = path.join(projectRoot, '.next', 'server');
    const hashes = {};

    await walkHtmlFiles(path.join(serverDir, 'app'), path.join(serverDir, 'app'), hashes, logger);
    await walkHtmlFiles(
        path.join(serverDir, 'pages'),
        path.join(serverDir, 'pages'),
        hashes,
        logger
    );

    if (!basePath) return hashes;

    const prefixed = {};
    for (const [urlPath, hash] of Object.entries(hashes)) {
        prefixed[basePath + urlPath] = hash;
    }
    return prefixed;
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
