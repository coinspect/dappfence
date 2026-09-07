/**
 * Framework-agnostic manifest generation pipeline.
 * Used internally by @dappfence/astro, @dappfence/next, and any future integrations.
 */
const { promises: fs } = require('fs');
const path = require('path');
const { calculateFileHash, signManifest } = require('./build');
const { TRANSFORM } = require('@dappfence/core/constants');
const { extractInlineHashesFromHtml } = require('./inline-scripts');

const CDP_SCRIPT_PATH = '/.netlify/scripts/cdp';

// Pre-computed hashes for known Netlify CDP script versions.
// Add new entries here when Netlify ships an updated script.
const NETLIFY_CDP_KNOWN_HASHES = [
    'sha256-pTgm3D8vQpOitZlnprm7whsvUg/r487ILpgWI9NblUQ=', // 2026-06
];

function buildNetlifyContentRules() {
    return [
        {
            condition: { resourceTypes: ['document'] },
            action: { type: 'transform', transform: TRANSFORM.NETLIFY_CDP },
        },
        {
            condition: { urlFilter: CDP_SCRIPT_PATH },
            action: { type: 'verify' },
        },
        {
            condition: { urlFilter: CDP_SCRIPT_PATH },
            action: { type: 'rewrite' },
        },
    ];
}

/**
 * Return SRI hashes for the Netlify CDP script: always includes NETLIFY_CDP_KNOWN_HASHES,
 * plus a freshly fetched hash when process.env.URL is available.
 * The rewrite content rule handles any version not yet in the known list.
 */
async function resolveNetlifyCdpHashes(logger) {
    const hashes = [...NETLIFY_CDP_KNOWN_HASHES];
    const siteUrl = process.env.URL;
    if (!siteUrl) {
        logger.warn(
            `DappFence: NETLIFY=true but URL env var not set; ${CDP_SCRIPT_PATH} verification limited to known hashes`
        );
        return hashes;
    }
    try {
        const res = await fetch(siteUrl + CDP_SCRIPT_PATH);
        if (res.ok) {
            const hash = calculateFileHash(Buffer.from(await res.arrayBuffer()));
            if (!hashes.includes(hash)) {
                hashes.unshift(hash);
                logger.warn(
                    `DappFence: ${CDP_SCRIPT_PATH} — fetched an unknown hash (${hash}); Netlify may have updated the script. ` +
                        'Add it to NETLIFY_CDP_KNOWN_HASHES in @dappfence/manifest-tools.'
                );
            } else {
                logger.info(`DappFence: fetched and verified ${CDP_SCRIPT_PATH} hash`);
            }
        } else {
            logger.warn(
                `DappFence: ${CDP_SCRIPT_PATH} fetch returned HTTP ${res.status}; falling back to known hashes`
            );
        }
    } catch (err) {
        logger.warn(
            `DappFence: could not fetch ${CDP_SCRIPT_PATH} — ${err.message}; falling back to known hashes`
        );
    }
    return hashes;
}

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

async function walk(base, dir, excludes, pathPrefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
        entries.map(async (entry) => {
            const abs = path.join(dir, entry.name);
            const web = pathPrefix + '/' + path.relative(base, abs).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (excludes.some((e) => web.startsWith(e))) return [];
                return walk(base, abs, excludes, pathPrefix);
            }
            if (entry.isFile()) {
                if (excludes.some((e) => web.startsWith(e))) return [];
                const ext = path.extname(entry.name).toLowerCase();
                return [{ webPath: web, absPath: abs, ext }];
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
 * @param {string[]} [opts.exclude]         - Web path prefixes to skip
 * @param {string}   [opts.secretKey]       - Hex secret key for signing; omit to produce unsigned manifest
 * @param {string}   [opts.mode]            - Manifest mode ('protected' | 'reporting')
 * @param {string[]} [opts.dynamicRoutes]   - SSR route patterns recorded in metadata for future use (not hashed)
 * @param {object[]} [opts.pathRules]       - Path resolution rules (e.g. directory-index, html-extension)
 * @param {object[]} [opts.contentRules]    - Content verification rules (e.g. netlify-cdp transform)
 * @param {Function} [opts.pageFilter]      - (webPath, ext) => bool; identifies HTML pages for script injection
 *                                           Defaults to any .html/.htm file
 * @param {object}   [opts.scriptAttrs]     - Options passed to buildScriptAttrs for injection; omit to skip injection
 * @param {object}   opts.logger            - Logger with .info / .warn / .error
 * @param {object}   [opts.extraHashes]     - Pre-computed { webPath: sriHash } entries merged into files
 *                                           (e.g. SSR routes hashed by the integration at build time)
 * @param {string}   [opts.pathPrefix]      - URL prefix prepended to every hashed file's web path.
 *                                           Use when outDir maps to a URL sub-path (e.g. '/_next/static').
 * @param {object}   [opts.csp]             - CSP configuration merged into the manifest.
 *   Each *Origins field is additive to the SW's secure default (which already includes
 *   `'self'` plus `data:` for img-src and `'unsafe-inline'` for style-src); the manifest
 *   cannot introduce `'unsafe-*'` keywords or `*` wildcards. See sw/manifest/csp.js.
 *   @param {string[]} [opts.csp.connectOrigins]      - Extra origins for connect-src.
 *   @param {string[]} [opts.csp.formActionOrigins]   - Extra origins for form-action.
 *   @param {string[]} [opts.csp.frameOrigins]        - Extra origins for frame-src (iframes).
 *                                                      Only emitted when non-empty.
 *   @param {string[]} [opts.csp.mediaOrigins]        - Extra origins for media-src (<audio>/<video>).
 *                                                      Only emitted when non-empty.
 *   @param {string[]} [opts.csp.manifestSrcOrigins]  - Extra origins for manifest-src (web app manifest).
 *   @param {string[]} [opts.csp.imgOrigins]          - Extra origins for img-src.
 *   @param {string[]} [opts.csp.fontOrigins]         - Extra origins for font-src.
 *   @param {string[]} [opts.csp.styleOrigins]        - Extra origins for style-src (external stylesheets).
 *   @param {string[]} [opts.csp.frameAncestors]      - Parents allowed to embed this page.
 *                                                      When non-empty, emits `'self' + <values>` instead of `'none'`.
 *   @param {boolean}  [opts.csp.upgradeInsecureRequests] - Tri-state: true forces the directive on,
 *                                                          false forces it off, omit to defer to the
 *                                                          SW's `csp_upgrade_insecure_requests` feature
 *                                                          flag (defaults to true when absent).
 *   @param {boolean}  [opts.csp.reportSample] - Tri-state: forces `'report-sample'` on/off, omit to
 *                                               defer to the SW's `csp_report_sample` flag (dev=true, prod=false).
 *   @param {object}   [opts.csp.pages]               - Pre-built { pageKey: {scripts,attrs} } map for SSR routes.
 *                                                      Static HTML pages are extracted automatically during the walk.
 */
async function generateManifest({
    outDir,
    manifestPath,
    exclude,
    secretKey,
    mode,
    pathRules,
    contentRules,
    pageFilter,
    scriptAttrs,
    logger,
    extraHashes,
    pathPrefix = '',
    csp,
}) {
    const excludes = [...(exclude || []), pathPrefix + '/' + manifestPath];
    const isPage = pageFilter || ((_webPath, ext) => ext === '.html' || ext === '.htm');

    const files = await walk(outDir, outDir, excludes, pathPrefix);
    logger.info(`DappFence: hashing ${files.length} files`);

    const fileHashes = {};
    const cspBuiltPages = {};
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

        if (isPage(webPath, ext)) {
            try {
                const html = buf.toString('utf8');
                const { scripts, attrs, warnings } = extractInlineHashesFromHtml(html);
                for (const w of warnings) {
                    logger.warn(`DappFence: ${webPath}: ${w}`);
                }
                if (scripts.length || attrs.length) {
                    cspBuiltPages[webPath] = {
                        ...(scripts.length && { scripts }),
                        ...(attrs.length && { attrs }),
                    };
                }
            } catch (err) {
                logger.warn(`DappFence: CSP hash extraction failed for ${webPath}: ${err.message}`);
            }
        }
    }

    if (extraHashes) {
        const count = Object.keys(extraHashes).length;
        Object.assign(fileHashes, extraHashes);
        logger.info(`DappFence: merged ${count} pre-computed SSR route hash(es) into manifest`);
    }

    const cspPages = { ...cspBuiltPages, ...(csp?.pages ?? {}) };
    // CSP headers are always layered on document responses by the SW (see
    // verifier.js § layerCsp). Content-verification is orthogonal: static
    // pages fall through to the SW's default `verify`; SSR routes must
    // declare `{ action: { type: 'csp' } }` explicitly to opt out of verify.
    // No implicit document-scoped rule is emitted here.
    const effectiveContentRules = contentRules ?? [];

    const payload = {
        files: fileHashes,
        pathRules: pathRules ?? [],
        contentRules: effectiveContentRules,
        mode,
        csp: {
            connectOrigins: csp?.connectOrigins ?? [],
            formActionOrigins: csp?.formActionOrigins ?? [],
            frameOrigins: csp?.frameOrigins ?? [],
            mediaOrigins: csp?.mediaOrigins ?? [],
            manifestSrcOrigins: csp?.manifestSrcOrigins ?? [],
            imgOrigins: csp?.imgOrigins ?? [],
            fontOrigins: csp?.fontOrigins ?? [],
            styleOrigins: csp?.styleOrigins ?? [],
            frameAncestors: csp?.frameAncestors ?? [],
            ...(typeof csp?.upgradeInsecureRequests === 'boolean'
                ? { upgradeInsecureRequests: csp.upgradeInsecureRequests }
                : {}),
            ...(typeof csp?.reportSample === 'boolean' ? { reportSample: csp.reportSample } : {}),
            pages: cspPages,
        },
        metadata: {
            buildTime: new Date().toISOString(),
            version: 'latest',
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
    SCRIPT_ATTRS_DEFAULTS,
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    walk,
    generateManifest,
    buildNetlifyContentRules,
    NETLIFY_CDP_KNOWN_HASHES,
    resolveNetlifyCdpHashes,
};
