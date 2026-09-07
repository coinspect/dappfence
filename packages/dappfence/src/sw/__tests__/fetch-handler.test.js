import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifier } from '../manifest/verifier.js';
import { isFeatureEnabled } from '../../core/utils.js';

vi.mock('../../templates/security-warning.html?raw', () => ({
    default:
        '<html><style>/* CSS will be injected here during build */</style><script id="dappfence-config">const DAPPFENCE_CONFIG = {};</script></html>',
}));
vi.mock('../../templates/security-warning.css?raw', () => ({
    default: 'body {}',
}));
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

const ORIGIN = 'https://example.com';
const CROSS_ORIGIN = 'https://cdn.example.com';

function makePrepareRequest() {
    const swContext = {
        getLocationHref: () => `${ORIGIN}/dappfence.js`,
        matchAllClients: () => Promise.resolve([]),
    };
    const appStore = { verificationResultsStore: { add: vi.fn() } };
    const config = { manifestUrl: null };
    const manifestLoader = {
        storeManifestFromResponse: vi.fn(),
        fetchAndStoreManifest: vi.fn(),
        getManifestHistory: vi.fn(() => Promise.resolve([])),
    };
    const { prepareRequest } = createVerifier({ swContext, appStore, config }, manifestLoader);
    // Wrap to match old (request, _origin) call signature; manifest not needed for these tests.
    return (request) => prepareRequest(request, null);
}

function makeRequest(url, { destination, mode, ...init } = {}) {
    const req = new Request(url, {
        ...init,
        ...(mode && mode !== 'navigate' ? { mode } : {}),
    });
    if (mode === 'navigate') {
        Object.defineProperty(req, 'mode', { value: 'navigate', configurable: true });
    }
    if (destination !== undefined) {
        Object.defineProperty(req, 'destination', { value: destination, configurable: true });
    }
    return req;
}

describe('prepareRequest', () => {
    let prepareRequest;
    beforeEach(() => {
        isFeatureEnabled.mockReturnValue(false);
        prepareRequest = makePrepareRequest();
    });

    describe('returns original request unchanged', () => {
        it('cross-origin non-script', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/img.png`);
            expect(prepareRequest(req)).toBe(req);
        });

        it('cross-origin script with cors mode (not no-cors)', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'cors',
                destination: 'script',
            });
            expect(prepareRequest(req)).toBe(req);
        });

        it('same-origin with mark_request disabled', () => {
            const req = makeRequest(`${ORIGIN}/app.js`);
            expect(prepareRequest(req)).toBe(req);
        });
    });

    describe('no-cors script upgrade', () => {
        beforeEach(() => {
            isFeatureEnabled.mockImplementation((flag) => flag === 'force_cors_scripts');
        });

        it('returns original request when force_cors_scripts is disabled', () => {
            isFeatureEnabled.mockReturnValue(false);
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req)).toBe(req);
        });

        it('returns a new request object', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req)).not.toBe(req);
        });

        it('upgrades mode to cors', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req).mode).toBe('cors');
        });

        it('forces credentials to omit regardless of original value', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                credentials: 'include',
            });
            expect(prepareRequest(req).credentials).toBe('omit');
        });

        it('preserves url', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req).url).toBe(`${CROSS_ORIGIN}/lib.js`);
        });

        it('preserves method', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                method: 'GET',
            });
            expect(prepareRequest(req).method).toBe('GET');
        });

        it('preserves cache', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                cache: 'no-store',
            });
            expect(prepareRequest(req).cache).toBe('no-store');
        });

        it('preserves redirect', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                redirect: 'manual',
            });
            expect(prepareRequest(req).redirect).toBe('manual');
        });

        it('preserves referrerPolicy', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                referrerPolicy: 'no-referrer',
            });
            expect(prepareRequest(req).referrerPolicy).toBe('no-referrer');
        });

        it('preserves integrity', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                integrity: 'sha256-abc123',
            });
            expect(prepareRequest(req).integrity).toBe('sha256-abc123');
        });

        it('propagates abort from original signal', () => {
            const controller = new AbortController();
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
                signal: controller.signal,
            });
            const result = prepareRequest(req);
            expect(result.signal.aborted).toBe(false);
            controller.abort();
            expect(result.signal.aborted).toBe(true);
        });

        it('preserves destination', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req).destination).toBe('script');
        });

        it('does not add mark header when mark_request is disabled', () => {
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req).headers.get('x-dappfence')).toBeNull();
        });

        it('adds mark header when mark_request is enabled', () => {
            isFeatureEnabled.mockReturnValue(true);
            const req = makeRequest(`${CROSS_ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            expect(prepareRequest(req).headers.get('x-dappfence')).toBe('processed');
        });

        it('also upgrades same-origin no-cors scripts', () => {
            const req = makeRequest(`${ORIGIN}/lib.js`, {
                mode: 'no-cors',
                destination: 'script',
            });
            const result = prepareRequest(req);
            expect(result.mode).toBe('cors');
            expect(result.credentials).toBe('omit');
        });
    });

    describe('mark_request tracking header', () => {
        beforeEach(() => {
            isFeatureEnabled.mockReturnValue(true);
        });

        describe('navigate requests', () => {
            it('returns a new request object', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate' });
                expect(prepareRequest(req)).not.toBe(req);
            });

            it('adds x-dappfence header', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate' });
                expect(prepareRequest(req).headers.get('x-dappfence')).toBe('processed');
            });

            it('preserves existing headers alongside the mark', () => {
                const req = makeRequest(`${ORIGIN}/`, {
                    mode: 'navigate',
                    headers: { accept: 'text/html' },
                });
                const result = prepareRequest(req);
                expect(result.headers.get('x-dappfence')).toBe('processed');
                expect(result.headers.get('accept')).toBe('text/html');
            });

            it('preserves method', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate' });
                expect(prepareRequest(req).method).toBe('GET');
            });

            it('preserves credentials', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate' });
                expect(prepareRequest(req).credentials).toBe(req.credentials);
            });

            it('preserves cache', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate', cache: 'no-store' });
                expect(prepareRequest(req).cache).toBe('no-store');
            });

            it('preserves referrerPolicy', () => {
                const req = makeRequest(`${ORIGIN}/`, {
                    mode: 'navigate',
                    referrerPolicy: 'no-referrer',
                });
                expect(prepareRequest(req).referrerPolicy).toBe('no-referrer');
            });

            it('preserves integrity', () => {
                const req = makeRequest(`${ORIGIN}/`, {
                    mode: 'navigate',
                    integrity: 'sha256-abc123',
                });
                expect(prepareRequest(req).integrity).toBe('sha256-abc123');
            });

            it('does not carry mode=navigate (rejected by Request constructor)', () => {
                const req = makeRequest(`${ORIGIN}/`, { mode: 'navigate' });
                expect(prepareRequest(req).mode).not.toBe('navigate');
            });

            it('preserves destination', () => {
                const req = makeRequest(`${ORIGIN}/`, {
                    mode: 'navigate',
                    destination: 'document',
                });
                expect(prepareRequest(req).destination).toBe('document');
            });
        });

        describe('non-navigate same-origin requests', () => {
            it('returns a new request object', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { mode: 'same-origin' });
                expect(prepareRequest(req)).not.toBe(req);
            });

            it('adds x-dappfence header', () => {
                const req = makeRequest(`${ORIGIN}/app.js`);
                expect(prepareRequest(req).headers.get('x-dappfence')).toBe('processed');
            });

            it('preserves existing headers alongside the mark', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, {
                    headers: { accept: 'application/javascript' },
                });
                const result = prepareRequest(req);
                expect(result.headers.get('x-dappfence')).toBe('processed');
                expect(result.headers.get('accept')).toBe('application/javascript');
            });

            it('preserves mode', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { mode: 'same-origin' });
                expect(prepareRequest(req).mode).toBe('same-origin');
            });

            it('preserves credentials', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { credentials: 'include' });
                expect(prepareRequest(req).credentials).toBe('include');
            });

            it('preserves cache', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { cache: 'no-cache' });
                expect(prepareRequest(req).cache).toBe('no-cache');
            });

            it('preserves redirect', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { redirect: 'manual' });
                expect(prepareRequest(req).redirect).toBe('manual');
            });

            it('preserves referrerPolicy', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { referrerPolicy: 'no-referrer' });
                expect(prepareRequest(req).referrerPolicy).toBe('no-referrer');
            });

            it('preserves integrity', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { integrity: 'sha256-abc123' });
                expect(prepareRequest(req).integrity).toBe('sha256-abc123');
            });

            it('preserves keepalive', () => {
                const req = makeRequest(`${ORIGIN}/app.js`, { keepalive: true });
                expect(prepareRequest(req).keepalive).toBe(true);
            });

            it('propagates abort from original signal', () => {
                const controller = new AbortController();
                const req = makeRequest(`${ORIGIN}/app.js`, { signal: controller.signal });
                const result = prepareRequest(req);
                expect(result.signal.aborted).toBe(false);
                controller.abort();
                expect(result.signal.aborted).toBe(true);
            });
        });
    });
});
