/**
 * Framework-agnostic manifest generation pipeline.
 * Used internally by @dappfence/astro, @dappfence/next, and any future integrations.
 */
const { promises: fs } = require('fs');
const path = require('path');
const { calculateFileHash, signManifest } = require('./build');

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.htm', '.svg'];

const SCRIPT_ATTRS_DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
};

function buildScriptAttrs(opts = {}) {
    const resolved = { ...SCRIPT_ATTRS_DEFAULTS, ...opts };
    const attrs = { src: resolved.scriptSrc };
    if (resolved.manifestUrl) attrs['data-manifest'] = resolved.manifestUrl;
    if (resolved.manifestSignatureType)
        attrs['data-manifest-signature-type'] = resolved.manifestSignatureType;
    if (resolved.manifestSignatureIdentity)
        attrs['data-manifest-signature-identity'] = resolved.manifestSignatureIdentity;
    if (resolved.appSW) attrs['data-app-sw'] = resolved.appSW;
    if (resolved.warningUrl) attrs['data-warning-url'] = resolved.warningUrl;
    return attrs;
}

function buildScriptTag(opts) {
    const attrStr = Object.entries(buildScriptAttrs(opts))
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
    return `<script ${attrStr}></script>`;
}

function injectScriptTag(html, opts) {
    const tag = buildScriptTag(opts);
    if (html.includes(tag)) return html;
    return html.replace(/(<head[^>]*>)/i, `$1\n    ${tag}`);
}

async function walk(base, dir, extensions, excludes) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
        entries.map(async (entry) => {
            const abs = path.join(dir, entry.name);
            const web = '/' + path.relative(base, abs).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (excludes.some((e) => web.startsWith(e))) return [];
                return walk(base, abs, extensions, excludes);
            }
            if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext) && !excludes.some((e) => web.startsWith(e))) {
                    return [{ webPath: web, absPath: abs, ext }];
                }
            }
            return [];
        })
    );
    return results.flat();
}

/**
 * Walk outDir, optionally inject the dappfence script tag into HTML pages,
 * hash all tracked files, sign, and write the manifest.
 *
 * @param {object} opts
 * @param {string}   opts.outDir            - Absolute path to the output directory to walk
 * @param {string}   opts.manifestPath      - Relative path for the manifest file (e.g. 'integrity-manifest.json')
 * @param {string}   opts.manifestUrl       - Public URL where the manifest will be served (e.g. '/integrity-manifest.json')
 * @param {string[]} [opts.extensions]      - File extensions to track (defaults to DEFAULT_EXTENSIONS)
 * @param {string[]} [opts.exclude]         - Web path prefixes to skip
 * @param {string}   [opts.secretKey]       - Hex secret key for signing; omit to produce unsigned manifest
 * @param {string}   [opts.mode]            - Manifest mode ('protected' | 'reporting')
 * @param {string[]} [opts.dynamicRoutes]   - SSR route patterns to record in metadata (not hashed)
 * @param {Function} [opts.pageFilter]      - (webPath, ext) => bool; identifies HTML pages for script injection
 *                                           Defaults to any .html/.htm file
 * @param {object}   [opts.scriptAttrs]     - Options passed to buildScriptAttrs for injection; omit to skip injection
 * @param {object}   opts.logger            - Logger with .info / .warn / .error
 */
async function generateManifest({
    outDir,
    manifestPath,
    extensions,
    exclude,
    secretKey,
    mode,
    dynamicRoutes,
    pageFilter,
    scriptAttrs,
    logger,
}) {
    const exts = extensions || DEFAULT_EXTENSIONS;
    const excludes = [...(exclude || []), '/' + manifestPath];
    const isPage = pageFilter || ((_webPath, ext) => ext === '.html' || ext === '.htm');

    if (dynamicRoutes?.length) {
        logger.info(`DappFence: ${dynamicRoutes.length} dynamic (SSR) routes captured`);
    }

    const files = await walk(outDir, outDir, exts, excludes);
    logger.info(`DappFence: hashing ${files.length} files`);

    const fileHashes = {};
    for (const { webPath, absPath, ext } of files) {
        let buf = await fs.readFile(absPath);

        if (scriptAttrs && isPage(webPath, ext)) {
            const html = buf.toString('utf8');
            const injected = injectScriptTag(html, scriptAttrs);
            if (injected !== html) {
                await fs.writeFile(absPath, injected, 'utf8');
                buf = Buffer.from(injected, 'utf8');
                logger.info(`DappFence: injected script tag into ${webPath}`);
            }
        }

        fileHashes[webPath] = calculateFileHash(buf);
    }

    const payload = {
        files: fileHashes,
        mode,
        metadata: {
            extensions: exts,
            buildTime: new Date().toISOString(),
            version: 'latest',
            ...(dynamicRoutes?.length && { dynamicRoutes }),
        },
    };

    let manifest;
    if (secretKey) {
        try {
            manifest = signManifest(payload, { secretKey });
            logger.info('DappFence: manifest signed');
        } catch (err) {
            logger.error(`DappFence: signing failed — ${err.message}`);
            manifest = { pay: payload };
        }
    } else {
        manifest = { pay: payload };
        logger.warn('DappFence: no signing keys provided, manifest is unsigned');
    }

    const out = path.join(outDir, manifestPath);
    await fs.writeFile(out, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info(`DappFence: manifest written → ${manifestPath}`);
}

module.exports = {
    DEFAULT_EXTENSIONS,
    SCRIPT_ATTRS_DEFAULTS,
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    walk,
    generateManifest,
};
