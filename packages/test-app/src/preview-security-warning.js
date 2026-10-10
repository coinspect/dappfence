#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 5555;
const constantsPath = fileURLToPath(import.meta.resolve('@dappfence/core/constants'));
const templatesDir = resolve(dirname(constantsPath), '../templates');

function loadBaseHtml() {
    const html = readFileSync(resolve(templatesDir, 'security-warning.html'), 'utf8');
    const css = readFileSync(resolve(templatesDir, 'security-warning.css'), 'utf8');
    return html.replace('/* CSS will be injected here during build */', css);
}

const now = Date.now();
const ts = (minutesAgo = 0) => new Date(now - minutesAgo * 60_000).toISOString();
const fmt = (iso) => new Date(iso).toLocaleString();

const sampleBlocks = {
    mismatch: {
        id: 'block_mismatch_1',
        status: 'MISMATCH',
        assetType: 'asset',
        fileKey: '/app.js',
        url: 'https://example.com/app.js',
        reason: null,
        expectedHashes: ['sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa='],
        actualHash: 'sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=',
        occurrenceCount: 2,
        timestamp: ts(5),
        formattedTimestamp: fmt(ts(5)),
        view: {
            title: 'File content tampered',
            expectedLabel: 'Expected hash',
            actualLabel: 'Actual hash',
        },
    },
    notFound: {
        id: 'block_notfound_1',
        status: 'NOT_FOUND_IN_MANIFEST',
        assetType: 'asset',
        fileKey: '/vendor/injected.js',
        url: 'https://example.com/vendor/injected.js',
        expectedHashes: [],
        actualHash: 'sha256-ccccccccccccccccccccccccccccccccccccccccccc=',
        occurrenceCount: 1,
        timestamp: ts(4),
        formattedTimestamp: fmt(ts(4)),
        view: { title: 'File not listed in trusted manifest', actualLabel: 'Actual hash' },
    },
    deniedByRule: {
        id: 'block_denied_1',
        status: 'DENIED_BY_RULE',
        assetType: 'asset',
        fileKey: '/analytics/tracker.js',
        url: 'https://example.com/analytics/tracker.js',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(3),
        formattedTimestamp: fmt(ts(3)),
        view: { title: 'File blocked by security rule' },
    },
    errorFetch: {
        id: 'block_error_1',
        status: 'ERROR',
        assetType: 'asset',
        fileKey: '/critical.js',
        url: 'https://example.com/critical.js',
        reason: 'FETCH_BAD_STATUS',
        httpStatus: 500,
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(2),
        formattedTimestamp: fmt(ts(2)),
        view: { title: 'Verification failed: non-OK HTTP status' },
    },
    signerChanged: {
        id: 'block_signer_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'SIGNER_CHANGED',
        expectedHashes: [
            'noble-secp256k1-recovered-eth:0x0d5b81e9bd4d6ab0a0487ea9fe161a4152b11625',
        ],
        actualHash: 'noble-secp256k1-recovered-eth:0xa4d9aa32b1c60e1a2396eb49a81a92936ab1abc2',
        occurrenceCount: 1,
        timestamp: ts(1),
        formattedTimestamp: fmt(ts(1)),
        view: {
            title: 'Manifest signer changed since pinning',
            expectedLabel: 'Pinned signer',
            actualLabel: 'Current signer',
        },
    },
    signatureMismatch: {
        id: 'block_sigmismatch_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'SIGNATURE_MISMATCH',
        expectedHashes: [
            'noble-secp256k1-recovered-eth:0x0d5b81e9bd4d6ab0a0487ea9fe161a4152b11625',
        ],
        actualHash: 'noble-secp256k1-recovered-eth:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        occurrenceCount: 1,
        timestamp: ts(6),
        formattedTimestamp: fmt(ts(6)),
        view: {
            title: 'Manifest signature identity does not match pinned signer',
            expectedLabel: 'Pinned signer',
            actualLabel: 'Recovered signer',
        },
    },
    configError: {
        id: 'block_config_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'CONFIG_ERROR',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(7),
        formattedTimestamp: fmt(ts(7)),
        view: { title: 'DappFence manifest is misconfigured' },
    },
    unsupportedSignature: {
        id: 'block_unsupported_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'UNSUPPORTED_SIGNATURE',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(8),
        formattedTimestamp: fmt(ts(8)),
        view: { title: 'Manifest signature uses an unsupported algorithm' },
    },
    signatureError: {
        id: 'block_sigerror_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'SIGNATURE_ERROR',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(9),
        formattedTimestamp: fmt(ts(9)),
        view: { title: 'Manifest signature verification threw an error' },
    },
    manifestParseError: {
        id: 'block_parse_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'MANIFEST_PARSE_ERROR',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(10),
        formattedTimestamp: fmt(ts(10)),
        view: { title: 'Manifest could not be parsed' },
    },
    manifestFetchBadStatus: {
        id: 'block_mfbadstatus_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'MANIFEST_FETCH_BAD_STATUS',
        httpStatus: 503,
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(11),
        formattedTimestamp: fmt(ts(11)),
        view: { title: 'Manifest fetch returned a non-OK status' },
    },
    manifestFetchException: {
        id: 'block_mfexception_1',
        status: 'MANIFEST_UNTRUSTED',
        assetType: 'manifest',
        fileKey: '/integrity-manifest.json',
        url: 'https://example.com/integrity-manifest.json',
        reason: 'MANIFEST_FETCH_EXCEPTION',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(12),
        formattedTimestamp: fmt(ts(12)),
        view: { title: 'Manifest fetch threw an exception' },
    },
    errorNullResponse: {
        id: 'block_err_null_1',
        status: 'ERROR',
        assetType: 'asset',
        fileKey: '/data/profile.json',
        url: 'https://example.com/data/profile.json',
        reason: 'NULL_RESPONSE',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(13),
        formattedTimestamp: fmt(ts(13)),
        view: { title: 'Verification failed: no response received' },
    },
    errorBodyUnreadable: {
        id: 'block_err_body_1',
        status: 'ERROR',
        assetType: 'asset',
        fileKey: '/images/hero.png',
        url: 'https://example.com/images/hero.png',
        reason: 'BODY_UNREADABLE',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(14),
        formattedTimestamp: fmt(ts(14)),
        view: { title: 'Verification failed: response body unreadable' },
    },
    errorFetchException: {
        id: 'block_err_fetch_1',
        status: 'ERROR',
        assetType: 'asset',
        fileKey: '/api/token.js',
        url: 'https://example.com/api/token.js',
        reason: 'FETCH_EXCEPTION',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(15),
        formattedTimestamp: fmt(ts(15)),
        view: { title: 'Verification failed: fetch threw' },
    },
    errorNoManifest: {
        id: 'block_err_nomanifest_1',
        status: 'ERROR',
        assetType: 'asset',
        fileKey: '/late-bound.js',
        url: 'https://example.com/late-bound.js',
        reason: 'NO_MANIFEST_AVAILABLE',
        expectedHashes: [],
        actualHash: null,
        occurrenceCount: 1,
        timestamp: ts(16),
        formattedTimestamp: fmt(ts(16)),
        view: { title: 'Verification failed: no trusted manifest available' },
    },
    serviceWorkerTampered: {
        id: 'block_sw_1',
        status: 'MISMATCH',
        assetType: 'service-worker',
        fileKey: '/sw_app.js',
        url: 'https://example.com/sw_app.js',
        reason: null,
        expectedHashes: ['sha256-swexpectedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx='],
        actualHash: 'sha256-swattackerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=',
        occurrenceCount: 1,
        timestamp: ts(17),
        formattedTimestamp: fmt(ts(17)),
        view: {
            title: 'File content tampered',
            expectedLabel: 'Expected hash',
            actualLabel: 'Actual hash',
        },
    },
};

const massTamperPaths = [
    '/app.js',
    '/vendor.js',
    '/runtime.js',
    '/polyfills.js',
    '/main.css',
    '/vendor.css',
    '/assets/logo.svg',
    '/assets/icons.woff2',
    '/js/analytics.js',
    '/js/wallet.js',
    '/js/sdk-bundle.js',
    '/js/third-party/react.production.min.js',
    '/js/third-party/react-dom.production.min.js',
    '/js/third-party/ethers.min.js',
    '/js/third-party/web3.min.js',
    '/service-worker.js',
    '/manifest.webmanifest',
    '/offline.html',
    '/favicon.ico',
];

const massTamperBlocks = massTamperPaths.map((fileKey, i) => ({
    id: `block_tamper_${i}`,
    status: 'MISMATCH',
    assetType: 'asset',
    fileKey,
    url: `https://example.com${fileKey}`,
    reason: null,
    expectedHashes: [
        `sha256-expected${i.toString().padStart(2, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=`,
    ],
    actualHash: `sha256-attacker${i.toString().padStart(2, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=`,
    occurrenceCount: 1 + (i % 3),
    timestamp: ts(10 + i),
    formattedTimestamp: fmt(ts(10 + i)),
    view: {
        title: 'File content tampered',
        expectedLabel: 'Expected hash',
        actualLabel: 'Actual hash',
    },
}));

const scenarios = {
    all: Object.values(sampleBlocks),
    mismatch: [sampleBlocks.mismatch, sampleBlocks.notFound],
    signer: [sampleBlocks.signerChanged],
    mixed: [sampleBlocks.mismatch, sampleBlocks.signerChanged, sampleBlocks.deniedByRule],
    allAssetTypes: [
        sampleBlocks.mismatch,
        sampleBlocks.serviceWorkerTampered,
        sampleBlocks.signerChanged,
    ],
    massTamper: massTamperBlocks,
    siteCompromised: [sampleBlocks.signerChanged, ...massTamperBlocks],
    empty: [],
};

function deriveSummary(blocks) {
    const hasManifest = blocks.some((b) => b.assetType === 'manifest');
    if (hasManifest) {
        return {
            subtitle: 'Manifest Trust Issue',
            message:
                "DappFence could not establish the authenticity of this site's manifest. " +
                'This can indicate a signer change, a signature mismatch, or a manifest ' +
                'configuration problem. Loading the site may expose you to untrusted content.',
        };
    }
    return {
        subtitle: 'Potentially Malicious Content Blocked',
        message:
            'DappFence has detected that content on this page has been modified and may be unsafe. ' +
            'This protection prevents potentially malicious code from running in your browser.',
    };
}

function renderPage(scenarioName) {
    const blocks = scenarios[scenarioName] ?? scenarios.all;
    const config = {
        apiToken: 'preview-token',
        activeBlocks: blocks,
        summary: deriveSummary(blocks),
        autoConfirmSiteLock: false,
    };
    const encoded = encodeURIComponent(JSON.stringify(config));
    const scriptTag = `<script>const DAPPFENCE_CONFIG = JSON.parse(decodeURIComponent("${encoded}"));</script>`;
    return loadBaseHtml().replace(/<script id="dappfence-config">[\s\S]*?<\/script>/, scriptTag);
}

function renderIndex() {
    const items = Object.keys(scenarios)
        .map((name) => {
            const count = scenarios[name].length;
            const label = `${name} <small>(${count} block${count === 1 ? '' : 's'})</small>`;
            return `<li><a href="/?scenario=${encodeURIComponent(name)}">${label}</a></li>`;
        })
        .join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>DappFence — Security Warning Preview</title>
<style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    h1 { margin-bottom: .5rem; }
    p { color: #555; }
    ul { padding-left: 1.25rem; }
    li { margin: .35rem 0; }
    a { color: #0b5fff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    small { color: #888; font-weight: normal; }
    code { background: #f4f4f6; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Security Warning Preview</h1>
<p>Pick a scenario to render the warning page. "Remove Site Lock" POSTs to a stub endpoint and redirects back here.</p>
<ul>
${items}
</ul>
<p>Edit <code>src/preview-security-warning.js</code> to add scenarios or tweak sample blocks. Refresh after template edits.</p>
</body>
</html>`;
}

function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
            return;
        }
        if (process.platform === 'darwin') {
            spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
            return;
        }
        const browsers = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
        for (const browser of browsers) {
            try {
                execFileSync('which', [browser], { stdio: 'ignore' });
                spawn(browser, [url], { stdio: 'ignore', detached: true }).unref();
                return;
            } catch (_e) {
                /* not found, try next */
            }
        }
        spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    } catch (_err) {
        console.log(`Open ${url} in your browser`);
    }
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/sw-api/site-unblock')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true,"message":"preview unblocked","timestamp":' + Date.now() + '}');
        return;
    }
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const scenario = parsed.searchParams.get('scenario');
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(scenario ? renderPage(scenario) : renderIndex());
});

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Security warning preview: ${url}`);
    console.log(`  Scenarios: ${Object.keys(scenarios).join(', ')}`);
    console.log(`  Example:   ${url}?scenario=signer`);
    openBrowser(url);
});
