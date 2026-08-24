#!/usr/bin/env node

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { connect } = require('node:net');

const { TRANSFORM } = require('@dappfence/core/constants');
const ASSET_ROOT = path.resolve(__dirname, '..', 'assets');
const DAPPFENCE_DIST = require.resolve('@dappfence/core');

/**
 * Named groups of virtual URL-to-file mappings.
 * Each entry maps an exact request path to a relative file path resolved
 * inside the active app directory (or ASSET_ROOT as fallback).
 * This fills the gap between extensionless CDN URLs and the physical files
 * on disk — without a blanket extension-guessing fallback.
 */
const VIRTUAL_FILE_GROUPS = {
    [TRANSFORM.NETLIFY_CDP]: {
        // Netlify injects /.netlify/scripts/cdp with no file extension;
        // cdp.js is the primary known-good variant stored in the manifest.
        '/.netlify/scripts/cdp': '.netlify/scripts/cdp.js',
    },
};

// --- Pure utilities ---

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.xml': 'text/xml',
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function calculateSRIHash(content) {
    const hash = crypto.createHash('sha256');
    hash.update(content);
    const digest = hash.digest('base64');
    return `sha256-${digest}`;
}

function getTimestamp() {
    return new Date().toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm format
}

function checkPattern(pattern, val) {
    try {
        return new RegExp(pattern).test(val);
    } catch (_e) {
        /* empty */
    }
    try {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regexString = escaped
            .replace(/\*\*/g, 'XXXX') // ** matches anything including /
            .replace(/\*/g, '([^/]*)') // * matches anything except /
            .replace(/XXXX/g, '(.*)') // ** matches anything including /
            .replace(/\?/g, '(.)'); // ? matches any single character
        return new RegExp(`^${regexString}$`).test(val);
    } catch (_e) {
        /* empty */
    }
    return pattern === val;
}

async function readJSON(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                console.log(
                    `[${getTimestamp()}]  \x1b[31m[READ-JSON] Error: ${err.message}\x1b[0m`
                );
                reject(err);
            }
        });
    });
}

function logRequestToConsole(req, testParams, result) {
    const isServiceWorkerRequest =
        req.headers['service-worker'] === 'script' ||
        req.headers['sec-fetch-dest'] === 'serviceworker';
    const hasDappFenceHeader = 'x-dappfence' in req.headers;
    const isCacheCheck = req.headers['if-modified-since'] || req.headers['if-none-match'];

    let indicator = '';
    let colorCode = '';
    if (isServiceWorkerRequest) {
        indicator = '[SW-REG]';
        colorCode = '\x1b[36m';
    } else if (hasDappFenceHeader) {
        indicator = '[DFSW-HDR]';
        colorCode = '\x1b[33m';
    } else {
        indicator = '[BYPASSED]';
        colorCode = '\x1b[31m';
    }
    const cacheIndicator = isServiceWorkerRequest ? '🔧' : isCacheCheck ? '💾' : '';

    console.log();
    console.log(
        `[${getTimestamp()}]  ${colorCode}${indicator}\x1b[0m ${cacheIndicator} ${req.method} ${testParams.url}`
    );
    console.log(
        '\ttest key:',
        testParams.testKey,
        'app:',
        testParams.appName,
        'version:',
        testParams.appVersion
    );
    console.log('\t', result);
}

function launchBrowserWithProxy(port) {
    const url = `http://localhost:${port}`;
    const proxyArg = `--proxy-server=http://localhost:${port}`;

    try {
        if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', 'chrome', proxyArg, url], {
                stdio: 'ignore',
                detached: true,
            }).unref();
            return;
        }

        if (process.platform === 'darwin') {
            const child = spawn('open', ['-a', 'Google Chrome', '--args', proxyArg, url], {
                stdio: 'ignore',
                detached: true,
            });
            child.on('error', () => {
                spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
            });
            child.unref();
            return;
        }

        // Linux: try Chrome/Chromium variants with proxy, fall back to xdg-open
        const { execFileSync } = require('child_process');
        const browsers = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
        for (const browser of browsers) {
            try {
                execFileSync('which', [browser], { stdio: 'ignore' });
                spawn(browser, [proxyArg, url], { stdio: 'ignore', detached: true }).unref();
                return;
            } catch (_e) {
                /* not found, try next */
            }
        }
        console.log(
            `⚠️  No Chrome/Chromium found. Falling back to xdg-open (no proxy — http:// CDN URLs will not resolve)`
        );
        console.log(`💡 To enable proxy, launch manually: chrome ${proxyArg} ${url}`);
        spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    } catch (_err) {
        console.log(`💡 Open ${url} in your browser`);
    }
}

// --- Server factory ---

/**
 * Start the DappFence dev/test server.
 *
 * @param {object} opts
 * @param {number}  [opts.port=3333]        - Port to listen on.
 * @param {string}  [opts.root]             - Root directory for app files. Defaults to
 *                                            the test-app's own dist/ directory.
 * @param {string}  [opts.defaultApp]       - Default app directory name (e.g. 'simple-app_latest').
 *                                            Takes precedence over per-request /api/test-config.
 * @param {boolean} [opts.noCache=false]    - Disable all caching headers.
 * @param {boolean} [opts.dev=false]          - Serve dappfence.js from @dappfence/core dist
 *                                              instead of the app directory.
 * @param {boolean} [opts.withBrowser=false]  - Open a browser tab after startup.
 * @param {string}  [opts.virtualFilesGroup]  - Name of a VIRTUAL_FILE_GROUPS entry to activate.
 *                                              Extensionless CDN URLs are resolved via this map.
 *                                              When unset no virtual-file mapping is applied.
 * @returns {Promise<http.Server>}            - Resolves once the server is listening.
 */
function startServer({
    port = 3333,
    root,
    defaultApp,
    noCache = false,
    dev = false,
    withBrowser = false,
    virtualFilesGroup = undefined,
} = {}) {
    const PROJECT_ROOT = root
        ? path.resolve(process.cwd(), root)
        : path.resolve(__dirname, '..', 'dist');

    const virtualFiles = VIRTUAL_FILE_GROUPS[virtualFilesGroup] ?? {};

    // Per-server mutable state — keyed by the request port (test isolation).
    const testParameters = {
        1: {
            appName: 'project-name',
            appVersion: 'latest',
            testTitle: 'example-test',
            testId: '111-222',
            responseHeaders: [{ match: '*', headers: { 'Cache-Control': 'max-age=3600' } }],
            saveResponses: false,
            testResponse: [],
        },
    };

    const INTERCEPT_FORMULAS = {
        default: (data, testParams, filePath) => {
            const p = filePath.trim().toLowerCase();
            if (p.endsWith('.json')) {
                const json = JSON.parse(data);
                json.pay = { ...json.pay, 'integrity-manifest.json': 'modified' };
                return JSON.stringify(json);
            } else if (p.endsWith('.html')) {
                return '<!-- modified -->\n' + data;
            } else if (p.endsWith('.js')) {
                return '// modified\n' + data;
            }
            return ' ' + data;
        },
        unchanged: (data) => data,
        empty: () => '',
        inject: (data, _testParams, _filePath, _pattern, args) => {
            const html = data.toString('utf8');
            const [content, target] = Array.isArray(args) ? args : [args];
            if (target && html.includes(target)) {
                return html.replace(target, content + target);
            }
            return html + content;
        },
        replace: (data, testParams, filePath, pattern, args) => {
            const replacement = path.join(PROJECT_ROOT, testParams.app, args);
            if (fs.existsSync(replacement) && fs.statSync(replacement).isFile()) {
                return fs.readFileSync(replacement, 'utf8');
            }
            console.log(
                `[${getTimestamp()}]  \x1b[31m[REPLACE] skipping, file not found ${replacement}\x1b[0m`
            );
            return data;
        },
    };

    function getExtraResponseHeaders(testParams) {
        const params = testParameters[testParams.testKey];
        if (params || noCache) {
            if (params && params.responseHeaders) {
                for (const rule of params.responseHeaders) {
                    if (rule.match && rule.headers) {
                        const regex = new RegExp('^' + rule.match.replace(/\*/g, '.*') + '$');
                        if (regex.test(testParams.requestPath)) {
                            return rule.headers;
                        }
                    }
                }
            }
            return {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            };
        }
        const cacheTimeout = 48 * 60 * 60; // 48 hours
        return { 'Cache-Control': `public, max-age=${cacheTimeout}, immutable` };
    }

    function saveTestResponse(
        testParams,
        result,
        filePath = '',
        extraHeaders = {},
        intercept = null
    ) {
        const params = testParameters[testParams.testKey];
        if (params && params.saveResponses) {
            if (!params.testResponse) {
                params.testResponse = [];
            }
            params.testResponse.push({ ...testParams, filePath, result, extraHeaders, intercept });
        }
    }

    function serveConfigTestApi(req, res, testParams) {
        readJSON(req)
            .then((params) => {
                if (!params.appName || !params.appVersion) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({ error: 'Missing required fields: appName and appVersion' })
                    );
                    return;
                }
                let intercept = [];
                if (params.intercept) {
                    intercept = Array.isArray(params.intercept)
                        ? params.intercept
                        : [params.intercept];
                    intercept = intercept.map((i) => ({
                        ...i,
                        formula:
                            i && i.formula && INTERCEPT_FORMULAS[i.formula] ? i.formula : 'default',
                    }));
                }
                testParameters[testParams.testKey] = {
                    ...testParameters[testParams.testKey],
                    ...params,
                    intercept,
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            })
            .catch(() => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            });
    }

    function serveApi(res, req, testParams) {
        const params = testParameters[testParams.testKey];
        if (req.method === 'DELETE') {
            console.log('');
            console.log(
                `[${getTimestamp()}]  \x1b[36m[TEST-CONFIG] Deleting test parameters for key ${testParams.testKey}\x1b[0m`
            );
            testParameters[testParams.testKey] = {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else if (req.method === 'POST' && testParams.requestPath === '/api/log') {
            readJSON(req, res)
                .then((json) => {
                    console.log('');
                    console.log(`[${getTimestamp()}]  \x1b[35m[CLIENT-LOG]\x1b[0m`, json);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                })
                .catch(() => {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
                });
        } else if (req.method === 'POST' && testParams.requestPath === '/api/test-config') {
            serveConfigTestApi(req, res, testParams);
        } else if (req.method === 'GET' && testParams.requestPath === '/api/test-responses') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            });
            res.end(JSON.stringify((params && params.testResponse) || []));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/test' });
            res.end('Internal server error');
        }
    }

    function serveFile(filePath, res, req, testParams) {
        fs.readFile(filePath, (err, data) => {
            if (err) {
                saveTestResponse(testParams, 'error reading file', filePath);
                logRequestToConsole(
                    req,
                    testParams,
                    `\x1b[31m ❌ ERROR ${filePath}, ${err.toString()}\x1b[0m`
                );
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
                return;
            }

            const sriHash = calculateSRIHash(data);
            const mimeType = getMimeType(filePath);
            const extraHeaders = getExtraResponseHeaders(testParams);
            const relativeFilePath = path.relative(PROJECT_ROOT, filePath);

            const params = testParameters[testParams.testKey];
            const intercept =
                params &&
                params.intercept &&
                params.intercept.find(
                    (i) => i.pattern && checkPattern(i.pattern, testParams.requestPath)
                );
            const resData = intercept
                ? INTERCEPT_FORMULAS[intercept.formula](
                      data,
                      testParams,
                      filePath,
                      intercept.pattern,
                      intercept.args
                  )
                : data;

            saveTestResponse(testParams, 'ok', filePath, extraHeaders, intercept);
            logRequestToConsole(
                req,
                testParams,
                `🔑 ${relativeFilePath}: ${sriHash} (${data.length} bytes) ${extraHeaders['Cache-Control'] || 'no-cache-header'}${intercept ? ` applied ${intercept.formula}` : ''}`
            );
            res.sendDate = false;
            res.writeHead(intercept?.statusCode ?? 200, {
                'Content-Type': (intercept && intercept.contentType) || mimeType,
                ...extraHeaders,
            });
            res.end(resData);
        });
    }

    function getTestParameters(req) {
        const host = req.headers.host;
        const origin = URL.parse(req.headers.origin) || URL.parse(`http://${host}`);
        const testKey = origin && origin.port;
        const params = testParameters[testKey];

        const baseUrl = new URL(req.url, host ? `http://${host}` : 'http://localhost:' + port);
        if (defaultApp) {
            return {
                testKey,
                app: defaultApp,
                appName: defaultApp.split('_')[0],
                appVersion: defaultApp.split('_')[1] || 'latest',
                testTitle: 'default',
                testId: 'default',
                url: baseUrl.toString(),
                requestPath: baseUrl.pathname,
            };
        }
        const { appName, appVersion, testTitle, testId } = params || {};
        return {
            testKey,
            app: appName + '_' + (appVersion || 'latest'),
            appName,
            appVersion,
            testTitle,
            testId,
            url: baseUrl.toString(),
            requestPath: baseUrl.pathname,
        };
    }

    // Hosts that simulate servers with no CORS support.
    // DappFence forces cors+omit on no-cors script requests, so scripts from these
    // hosts will fail with a TypeError — the browser rejects responses without
    // Access-Control-Allow-Origin even though the SW upgraded the request mode.
    const NO_CORS_HOSTS = new Set(['cors-unsupported-cdn.com']);

    const server = http.createServer((req, res) => {
        const testParams = getTestParameters(req);
        const host = (req.headers.host || '').split(':')[0];
        const isCorsSupported = !NO_CORS_HOSTS.has(host);

        const CORS_HEADERS = [
            'Access-Control-Allow-Origin',
            'Access-Control-Allow-Methods',
            'Access-Control-Allow-Headers',
        ].reduce((acc, header) => ({ ...acc, [header]: '*' }), {});

        if (req.method === 'OPTIONS') {
            if (isCorsSupported) {
                res.writeHead(204, CORS_HEADERS);
            } else {
                // No CORS headers → preflight denied → browser won't send the actual request.
                res.writeHead(403);
            }
            res.end();
            return;
        }
        if (isCorsSupported) {
            Object.keys(CORS_HEADERS).forEach((header) => {
                res.setHeader(header, CORS_HEADERS[header]);
            });
        }

        if (testParams.requestPath.startsWith('/api/')) {
            return serveApi(res, req, testParams);
        }

        if (dev && testParams.requestPath.endsWith('/dappfence.js')) {
            return serveFile(DAPPFENCE_DIST, res, req, testParams);
        }

        if (testParams.app) {
            const htmlRoot = path.join(PROJECT_ROOT, testParams.app);
            for (const p of ['', '.html', '/index.html']) {
                const filePath = path.join(htmlRoot, testParams.requestPath + p);
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    return serveFile(filePath, res, req, testParams);
                }
            }
        }

        const filePath = path.join(ASSET_ROOT, testParams.requestPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            return serveFile(filePath, res, req, testParams);
        }

        // Virtual file fallback: resolve extensionless CDN URLs to physical files.
        const virtualAlias = virtualFiles[testParams.requestPath];
        if (virtualAlias) {
            if (testParams.app) {
                const aliasPath = path.join(PROJECT_ROOT, testParams.app, virtualAlias);
                if (fs.existsSync(aliasPath) && fs.statSync(aliasPath).isFile()) {
                    return serveFile(aliasPath, res, req, testParams);
                }
            }
            const aliasPath = path.join(ASSET_ROOT, virtualAlias);
            if (fs.existsSync(aliasPath) && fs.statSync(aliasPath).isFile()) {
                return serveFile(aliasPath, res, req, testParams);
            }
        }

        // Synthetic intercept: apply a matching formula with empty input so formulas
        // like 'replace' and 'empty' can serve responses for paths with no base file
        // (e.g. extensionless CDN URLs declared explicitly in a test's intercept list).
        const testState = testParameters[testParams.testKey];
        const synthIntercept =
            testState?.intercept?.find(
                (i) => i.pattern && checkPattern(i.pattern, testParams.requestPath)
            ) ?? null;
        if (synthIntercept) {
            const resData = INTERCEPT_FORMULAS[synthIntercept.formula](
                Buffer.alloc(0),
                testParams,
                '',
                synthIntercept.pattern,
                synthIntercept.args
            );
            const mimeType =
                synthIntercept.contentType ||
                getMimeType(synthIntercept.args || testParams.requestPath) ||
                'application/octet-stream';
            const extraHeaders = getExtraResponseHeaders(testParams);
            saveTestResponse(testParams, 'synthetic', '', extraHeaders, synthIntercept);
            logRequestToConsole(
                req,
                testParams,
                `🔧 synthetic ${synthIntercept.formula} for ${testParams.requestPath}`
            );
            res.sendDate = false;
            res.writeHead(synthIntercept?.statusCode ?? 200, {
                'Content-Type': mimeType,
                ...extraHeaders,
            });
            res.end(resData);
            return;
        }

        saveTestResponse(testParams, 'file not found');
        logRequestToConsole(
            req,
            testParams,
            `\x1b[31m ❌ NOT FOUND ${req.method} ${testParams.url}\x1b[0m`
        );
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
    });

    const proxySockets = new Set();

    server.on('connect', (req, socket) => {
        const [targetHost, targetPortStr] = req.url.split(':');
        const isLocal = targetHost === 'localhost' || targetHost === '127.0.0.1';
        const targetPort = isLocal ? port : parseInt(targetPortStr, 10) || 443;
        const connectHost = isLocal ? 'localhost' : targetHost;
        const remote = connect(targetPort, connectHost, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            remote.pipe(socket);
            socket.pipe(remote);
        });
        proxySockets.add(socket);
        proxySockets.add(remote);
        remote.on('close', () => {
            proxySockets.delete(remote);
            socket.destroy();
        });
        socket.on('close', () => {
            proxySockets.delete(socket);
            remote.destroy();
        });
        remote.on('error', (e) => {
            console.log(
                `[${getTimestamp()}]  \x1b[31m[PROXY] Remote connection error: ${e.message}\x1b[0m`
            );
            socket.destroy();
        });
        socket.on('error', (e) => {
            console.log(
                `[${getTimestamp()}]  \x1b[31m[PROXY] Client socket error: ${e.message}\x1b[0m`
            );
            remote.destroy();
        });
    });

    server.destroyProxySockets = () => proxySockets.forEach((s) => s.destroy());

    server.setMaxListeners(Infinity);

    return new Promise((resolve) => {
        server.listen(port, () => {
            console.log(`🚀 DappFence Dev Server running at http://localhost:${port}`);
            if (defaultApp) console.log(`📁 Serving default app: ${defaultApp}`);
            console.log('');
            if (withBrowser) {
                launchBrowserWithProxy(port);
            }
            resolve(server);
        });
    });
}

module.exports = { startServer };

// --- CLI entry point ---

if (require.main === module) {
    const rootArg = process.argv.find((a) => a.startsWith('--root='));
    const pIndex = process.argv.indexOf('-p');
    const dIndex = process.argv.indexOf('-d');

    startServer({
        port: pIndex > 0 ? parseInt(process.argv[pIndex + 1]) : 3333,
        root: rootArg ? rootArg.slice('--root='.length) : undefined,
        defaultApp:
            dIndex > 0 && dIndex < process.argv.length - 1 ? process.argv[dIndex + 1] : undefined,
        noCache: process.argv.includes('--no-cache'),
        dev: process.argv.includes('--dev'),
        withBrowser: process.argv.includes('--with-browser'),
    }).then((server) => {
        console.log('Press Ctrl+C to stop');
        process.on('SIGINT', () => {
            console.log('\n👋 Shutting down dev server...');
            server.destroyProxySockets();
            server.closeAllConnections();
            server.close(() => {
                console.log('✅ Dev server stopped');
                process.exit(0);
            });
        });
    });
}
