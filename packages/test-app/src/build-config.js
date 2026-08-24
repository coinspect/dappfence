const path = require('path');
const { getPublicKey, hexToBytes } = require('@dappfence/manifest-tools/crypto');
const { MODE, TRANSFORM } = require('@dappfence/core/constants');

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

// This key is used for TESTING only
const secretKey = hexToBytes('46c88fcabce00eced90f15ceb9325fd879e44b43c623b174416a219a6103e05d');
const publicKey = getPublicKey(secretKey);
const keys = { publicKey, secretKey };

const defaultManifest = {
    mode: MODE.PROTECTED,
    pathRules: [{ type: 'directory-index' }, { type: 'not-found', fallback: '/404.html' }],
    contentRules: [
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
        manifests: {
            'integrity-manifest.json': { ...defaultManifest, mode: MODE.REPORTING },
            'no-not-found-manifest.json': {
                ...defaultManifest,
                pathRules: [{ type: 'directory-index' }],
                mode: MODE.REPORTING,
            },
        },
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
            dappfencePath: require.resolve(DAPPFENCE_PACKAGES[env]),
        };
    }
}
module.exports = {
    OUT_DIR,
    BUILD_TARGETS,
    keys,
    EXTERNAL_ASSETS,
};
