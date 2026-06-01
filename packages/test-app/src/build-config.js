const path = require('path');
const { getPublicKey, hexToBytes } = require('@dappfence/manifest-tools/crypto');
const { MODE } = require('@dappfence/core/constants');

const SECURITY_CONTENT_TYPES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.svg': 'image/svg+xml',
};

const EXTERNAL_ASSETS = {
    'http://code.jquery.com/jquery-3.7.1.min.js':
        'sha256-dHRfBy/qpMhrsW1oz1R0O4A+2QuM+wZNTuk8mQAKGBU=',
    'https://code.jquery.com/jquery-3.7.1.min.js':
        'sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=',
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

const simpleAppBase = {
    ...directories,
    manifestFile: 'integrity-manifest.json',
    manifestMode: MODE.PROTECTED,
    htmlOutput: 'index.html',
    description: 'Simple App Example',
    exclude: ['/test-excluded'],
    indexCopies: ['index_copy.html', path.join('some_subdirectory', 'index_copy.html')],
    versions: ['1.0.1'],
    htmlTemplates: { 'simple-app.html': 'index.html', 'front-page.html': 'front-page.html' },
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
        manifestFile: 'tampering-test-manifest.json',
        htmlTemplates: { 'tampering-test.html': 'index.html' },
        htmlOutput: 'tampering-test.html',
        description: 'Tampering Security Test',
    },
    'reporting-test': {
        ...simpleAppBase,
        templateFlags: { USE_SW_REGISTER: true, USE_APP: false },
        manifestMode: MODE.REPORTING,
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
    SECURITY_CONTENT_TYPES,
};
