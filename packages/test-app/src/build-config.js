import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicKey, hexToBytes } from '@dappfence/manifest-tools/crypto';
import { MODE, TRANSFORM } from '@dappfence/core/constants';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Remote destination for the /csp-cloud-* hand-QA pages. Set via env var at
// build time, e.g. `REPORTING_URL=https://... npm run build`, or put it in
// `.env.local` and run with `node --env-file=.env.local`. If unset, the two
// /csp-cloud-* pages + their manifests are skipped entirely and hidden from
// the Dev Tools table. Localhost worker URL for /csp-worker-* pages stays
// hardcoded on purpose.
const REPORTING_URL = process.env.REPORTING_URL ?? null;
if (!REPORTING_URL) {
    console.warn('[build-config] REPORTING_URL not set — skipping /csp-cloud-* pages');
}

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
    pathRules: [{ type: 'directory-index' }, { type: 'error-page', status: 404, url: '/404.html' }],
    redirects: [
        { from: '/', to: 'http://migrated.com:12345/', status: 302 },
        { from: '/redirect-to-front', to: '/front-page.html', status: 302 },
        { from: '/index.html', to: '/', status: 302 },
        { from: '/child/respond/front-page.html', to: '/front-page.html', status: 302 },
        { from: '/child/manual/child-nav-src', to: '/front-page.html', status: 302 },
        { from: '/legacy-page', to: 'http://migrated.site.com:12345/front-page.html', status: 301 },
    ],
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
            // Catch-all: every path starts with '/'. Any page generated from
            // simple-app.html has identical inline-script + on* attribute hashes
            // (template vars only land in attrs/comments, not inside <script>),
            // so one extraction covers all of them. Specific keys below win via
            // exact match.
            '/': { extractFrom: 'index.html' },
            '/csp-test-denied': [],
        },
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
    'csp-report.html': {
        template: 'simple-app.html',
        manifest: 'csp-report-manifest.json',
    },
    'csp-report-only.html': {
        template: 'simple-app.html',
        manifest: 'csp-report-only-manifest.json',
    },
    'no-csp-entries.html': {
        template: 'simple-app.html',
        manifest: 'no-csp-entries-manifest.json',
    },
    'telemetry.html': {
        template: 'simple-app.html',
        manifest: 'telemetry-manifest.json',
        templateFlags: {
            EVENTS_ENDPOINT_ATTR: 'data-events-endpoint="/capture/events-config"',
        },
    },
    'telemetry-reporting.html': {
        template: 'simple-app.html',
        manifest: 'telemetry-manifest-reporting.json',
        templateFlags: {
            EVENTS_ENDPOINT_ATTR: 'data-events-endpoint="/capture/events-config-reporting"',
        },
    },
    'csp-worker-protected.html': {
        template: 'simple-app.html',
        manifest: 'csp-worker-protected-manifest.json',
    },
    'csp-worker-reporting.html': {
        template: 'simple-app.html',
        manifest: 'csp-worker-reporting-manifest.json',
    },
    ...(REPORTING_URL && {
        'csp-cloud-protected.html': {
            template: 'simple-app.html',
            manifest: 'csp-cloud-protected-manifest.json',
        },
        'csp-cloud-reporting.html': {
            template: 'simple-app.html',
            manifest: 'csp-cloud-reporting-manifest.json',
        },
    }),
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
        'no-csp-entries-manifest.json': {
            ...defaultManifest,
            csp: { ...defaultManifest.csp, pages: {} },
        },
        'telemetry-manifest.json': {
            ...defaultManifest,
            telemetry: {
                eventsEndpoint: '/capture/events',
                logsEndpoint: '/capture/logs',
                logsFilter: 1,
            },
        },
        'telemetry-manifest-reporting.json': {
            ...defaultManifest,
            mode: MODE.REPORTING,
            telemetry: {
                eventsEndpoint: '/capture/events-reporting',
                logsEndpoint: '/capture/logs-reporting',
                logsFilter: 1,
            },
        },
        'csp-worker-protected-manifest.json': {
            ...defaultManifest,
            mode: MODE.PROTECTED,
            csp: {
                ...defaultManifest.csp,
                reportUri: 'http://127.0.0.1:8787/csp-report',
                reportSample: true,
            },
            telemetry: {
                eventsEndpoint: 'http://127.0.0.1:8787/report',
                logsEndpoint: 'http://127.0.0.1:8787/logs',
                logsFilter: 1,
            },
        },
        'csp-worker-reporting-manifest.json': {
            ...defaultManifest,
            mode: MODE.REPORTING,
            csp: {
                ...defaultManifest.csp,
                reportUri: 'http://127.0.0.1:8787/csp-report',
                reportSample: true,
            },
            telemetry: {
                eventsEndpoint: 'http://127.0.0.1:8787/report',
                logsEndpoint: 'http://127.0.0.1:8787/logs',
                logsFilter: 1,
            },
        },
        ...(REPORTING_URL && {
            'csp-cloud-protected-manifest.json': {
                ...defaultManifest,
                mode: MODE.PROTECTED,
                csp: {
                    ...defaultManifest.csp,
                    reportUri: `${REPORTING_URL}/csp-report`,
                    reportSample: true,
                },
                telemetry: {
                    eventsEndpoint: `${REPORTING_URL}/report`,
                    logsEndpoint: `${REPORTING_URL}/logs`,
                    logsFilter: 1,
                },
            },
            'csp-cloud-reporting-manifest.json': {
                ...defaultManifest,
                mode: MODE.REPORTING,
                csp: {
                    ...defaultManifest.csp,
                    reportUri: `${REPORTING_URL}/csp-report`,
                    reportSample: true,
                },
                telemetry: {
                    eventsEndpoint: `${REPORTING_URL}/report`,
                    logsEndpoint: `${REPORTING_URL}/logs`,
                    logsFilter: 1,
                },
            },
        }),
    },
    pages: simpleAppPages,
};

// Shared across every target; the Dev Tools table in simple-app.html uses it
// to hide the two /csp-cloud-* rows when REPORTING_URL is unset.
const CLOUD_FLAG = { BUILD_CLOUD_PAGES: !!REPORTING_URL };

const BUILD_CONFIGURATIONS = {
    'simple-app': {
        ...simpleAppBase,
        templateFlags: { ...CLOUD_FLAG, USE_APP_SW: false, USE_APP: true },
    },
    'simple-app-sw-fixed': {
        ...simpleAppBase,
        templateFlags: { ...CLOUD_FLAG, USE_APP_SW: true, USE_APP: true },
    },
    'simple-app-sw-capture': {
        ...simpleAppBase,
        templateFlags: { ...CLOUD_FLAG, USE_SW_REGISTER: true, USE_APP: false },
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
        templateFlags: { ...CLOUD_FLAG, USE_SW_REGISTER: true, USE_APP: false },
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
            dappfencePath: fileURLToPath(import.meta.resolve(DAPPFENCE_PACKAGES[env])),
        };
    }
}
export { OUT_DIR, BUILD_TARGETS, keys, EXTERNAL_ASSETS };
