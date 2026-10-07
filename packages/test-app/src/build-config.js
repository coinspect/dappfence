import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, hexToBytes } from '@dappfence/manifest-tools/crypto';
import { MODE, TRANSFORM } from '@dappfence/core/constants';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXTERNAL_ASSETS = {
    'http://code.jquery.com/jquery-3.7.1.min.js': [
        'sha256-dHRfBy/qpMhrsW1oz1R0O4A+2QuM+wZNTuk8mQAKGBU=',
        'sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=',
    ],
    'https://code.jquery.com/jquery-3.7.1.min.js':
        'sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=',
    'http://external-cdn.com/no-cors-test.js':
        'sha256-95XmetShyFXMsPtGjtYrWOVIOH96OQjUiODx8UmBMeg=',
    'http://cors-unsupported-cdn.com/no-cors-test.js':
        'sha256-95XmetShyFXMsPtGjtYrWOVIOH96OQjUiODx8UmBMeg=',
};

const ROOT_DIR = path.resolve(__dirname, '..');
const directories = {
    assetDir: path.resolve(ROOT_DIR, 'assets'),
    templateDir: path.resolve(ROOT_DIR, 'template'),
};

// These keys are used for TESTING only
const secretKeyA = hexToBytes('46c88fcabce00eced90f15ceb9325fd879e44b43c623b174416a219a6103e05d');
const secretKeyB = hexToBytes('a1b2c3d4e5f6071829304a5b6c7d8e9f0011223344556677889900aabbccddee');
const keyPairA = { publicKey: getPublicKey(secretKeyA), secretKey: secretKeyA };
const keyPairB = { publicKey: getPublicKey(secretKeyB), secretKey: secretKeyB };

const defaultManifest = {
    mode: MODE.PROTECTED,
    pathRules: [{ type: 'directory-index' }, { type: 'error-page', status: 404, url: '/404.html' }],
    contentRules: [
        // CSP rule BEFORE the transform so it fires first for /csp-test* paths.
        // The transform returns MATCH (terminal) on hash match and would prevent
        // the CSP action from running if ordered after.
        {
            condition: { resourceTypes: ['document'], urlFilter: '/csp-test-' },
            action: { type: 'csp' },
        },
        {
            condition: { resourceTypes: ['document'] },
            action: { type: 'transform', transform: TRANSFORM.NETLIFY_CDP },
        },
        {
            condition: { urlFilter: '/.netlify/scripts/cdp' },
            action: { type: 'verify' },
        },
        {
            condition: { urlFilter: '/.netlify/scripts/cdp' },
            action: { type: 'rewrite' },
        },
    ],
    additionalFiles: {
        '/.netlify/scripts/cdp': ['.netlify/scripts/cdp.js', '.netlify/scripts/cdp-alt.js'],
    },
    csp: {
        pages: {
            '/csp-test-allowed': { extractFrom: 'index.html' },
            '/csp-test-denied': [],
        },
    },
    keyPair: keyPairA,
};

const simpleAppPages = {
    'index.html': { template: 'simple-app.html', manifest: 'integrity-manifest.json' },
    'front-page.html': { template: 'front-page.html', manifest: 'integrity-manifest.json' },
    '404.html': { template: '404.html', manifest: 'integrity-manifest.json' },
    'index_copy.html': { template: 'simple-app.html', manifest: 'integrity-manifest.json' },
    'some_subdirectory/index_copy.html': {
        template: 'simple-app.html',
        manifest: 'integrity-manifest.json',
    },
    'no-not-found.html': { template: 'simple-app.html', manifest: 'no-not-found-manifest.json' },
    'csp-report.html': {
        template: 'simple-app.html',
        manifest: 'csp-report-manifest.json',
    },
    'csp-report-only.html': {
        template: 'simple-app.html',
        manifest: 'csp-report-only-manifest.json',
    },
    'signer-b.html': {
        template: 'simple-app.html',
        manifest: 'integrity-manifest-signer-b.json',
    },
    'revoke.html': {
        template: 'simple-app.html',
        manifest: 'integrity-manifest-revoke.json',
    },
};

const simpleAppBase = {
    ...directories,
    description: 'Simple App Example',
    exclude: ['/test-excluded'],
    versions: ['1.0.1'],
    manifests: {
        'integrity-manifest.json': defaultManifest,
        'no-not-found-manifest.json': {
            ...defaultManifest,
            pathRules: [{ type: 'directory-index' }],
        },
        'csp-report-manifest.json': {
            ...defaultManifest,
            csp: { ...defaultManifest.csp, reportUri: '/capture/csp', reportSample: true },
        },
        'csp-report-only-manifest.json': {
            ...defaultManifest,
            csp: {
                ...defaultManifest.csp,
                reportUri: '/capture/csp',
                reportOnly: true,
                reportSample: true,
            },
        },
        'integrity-manifest-signer-b.json': { ...defaultManifest, keyPair: keyPairB },
        'integrity-manifest-revoke.json': { ...defaultManifest, revokeManifests: true },
    },
    pages: simpleAppPages,
};

const BUILD_CONFIGURATIONS = {
    'simple-app': {
        ...simpleAppBase,
        templateFlags: { USE_APP_SW: false, USE_APP: true },
    },
    'simple-app-sw-fixed': {
        ...simpleAppBase,
        templateFlags: { USE_APP_SW: true, USE_APP: true },
    },
    'simple-app-sw-capture': {
        ...simpleAppBase,
        templateFlags: { USE_SW_REGISTER: true, USE_APP: false },
    },
    'tampering-test': {
        ...directories,
        description: 'Tampering Security Test',
        manifests: {
            'tampering-test-manifest.json': {
                keyPair: keyPairA,
                pathRules: [{ type: 'directory-index' }],
            },
        },
        pages: {
            'index.html': {
                template: 'tampering-test.html',
                manifest: 'tampering-test-manifest.json',
            },
        },
    },
    'reporting-test': {
        ...simpleAppBase,
        templateFlags: { USE_SW_REGISTER: true, USE_APP: false },
        manifests: Object.entries(simpleAppBase.manifests).reduce((acc, [k, m]) => {
            acc[k] = { ...m, mode: MODE.REPORTING };
            return acc;
        }, {}),
    },
};

const OUT_DIR = path.join(ROOT_DIR, 'dist');
const DAPPFENCE_PACKAGES = { dev: '@dappfence/core/dev', prod: '@dappfence/core' };
const BUILD_TARGETS = {};
for (const env in DAPPFENCE_PACKAGES) {
    for (const name in BUILD_CONFIGURATIONS) {
        const target = name + '-' + env;
        BUILD_TARGETS[target] = {
            ...BUILD_CONFIGURATIONS[name],
            outDir: path.join(OUT_DIR, target),
            dappfencePath: fileURLToPath(import.meta.resolve(DAPPFENCE_PACKAGES[env])),
        };
    }
}
export { OUT_DIR, BUILD_TARGETS, EXTERNAL_ASSETS };
