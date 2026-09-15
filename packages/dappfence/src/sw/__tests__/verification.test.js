import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    decodePathname,
    toPathname,
    verifyLocation,
    verifyManifestSignature,
    verifyImportedScript,
} from '../manifest/verification.js';
import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';

describe('decodePathname', () => {
    it('decodes safe reserved chars', () => {
        expect(decodePathname('/api/%5Bid%5D')).toBe('/api/[id]');
    });

    it('leaves %2F encoded', () => {
        expect(decodePathname('/api%2Fitem')).toBe('/api%2Fitem');
    });

    it('returns raw pathname on malformed input (lone %)', () => {
        expect(decodePathname('/%')).toBe('/%');
    });
});

describe('toPathname', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin URLs', () => {
        expect(toPathname('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(toPathname('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(toPathname('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        expect(toPathname('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(toPathname('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });

    it('percent-decodes safe reserved chars in pathname (Next dynamic-route keys)', () => {
        expect(toPathname('https://example.com/api/%5Bid%5D', baseUrl)).toBe('/api/[id]');
    });

    it("keeps %2F encoded so segments aren't merged", () => {
        expect(toPathname('https://example.com/api%2Fitem', baseUrl)).toBe('/api%2Fitem');
    });
});

describe('verifyManifestSignature', () => {
    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
    });
});

const baseHref = 'https://example.com/sw.js';

const mockManifestService = (verifyResponseMock) => ({
    resolveManifest: vi.fn().mockResolvedValue({ verifyResponse: verifyResponseMock }),
});

describe('verifyLocation', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('fetches the URL and returns the verifyResponse result', async () => {
        const verifyResponseResult = {
            status: VERIFICATION_STATUS.MATCH,
            fileKey: '/lib.js',
            expectedHashes: ['abc'],
            actualHash: 'abc',
        };
        const verifyResponse = vi.fn().mockResolvedValue(verifyResponseResult);
        const response = new Response('file content');
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue(response),
                getLocationHref: () => baseHref,
            },
            manifestService: mockManifestService(verifyResponse),
        };

        const result = await verifyLocation(deps, '/lib.js');

        expect(deps.swContext.fetch).toHaveBeenCalledWith('/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(verifyResponse).toHaveBeenCalledWith(
            { url: '/lib.js', destination: 'script', method: 'GET', mode: '' },
            response
        );
        expect(result).toEqual(verifyResponseResult);
    });

    it('returns ERROR with httpStatus on fetch failure', async () => {
        const verifyResponse = vi.fn();
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 }),
                getLocationHref: () => baseHref,
            },
            manifestService: mockManifestService(verifyResponse),
        };

        const result = await verifyLocation(deps, '/missing.js');

        expect(verifyResponse).not.toHaveBeenCalled();
        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR, httpStatus: 500 });
    });

    it('returns ERROR when fetch throws', async () => {
        const verifyResponse = vi.fn();
        const deps = {
            swContext: {
                fetch: vi.fn().mockRejectedValue(new Error('network down')),
                getLocationHref: () => baseHref,
            },
            manifestService: mockManifestService(verifyResponse),
        };

        const result = await verifyLocation(deps, '/lib.js');

        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR });
    });
});

describe('verifyImportedScript', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('does not record a violation on MATCH', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.MATCH,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('content')),
                getLocationHref: () => baseHref,
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(verifyResponse).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://example.com/lib.js', destination: 'script' }),
            expect.anything()
        );
        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('records a service-worker violation on MISMATCH', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.MISMATCH,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('bad')),
                getLocationHref: () => baseHref,
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.MISMATCH,
                assetType: ASSET_TYPE.SERVICE_WORKER,
                url: 'https://example.com/lib.js',
                fileKey: '/lib.js',
            })
        );
    });

    it('records a service-worker violation on fetch failure', async () => {
        const verifyResponse = vi.fn();
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
                getLocationHref: () => baseHref,
            },
        };

        await verifyImportedScript(core, 'https://example.com/missing.js');

        expect(verifyResponse).not.toHaveBeenCalled();
        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.ERROR,
                assetType: ASSET_TYPE.SERVICE_WORKER,
                url: 'https://example.com/missing.js',
                httpStatus: 404,
            })
        );
    });

    it('records a service-worker violation when fetch throws', async () => {
        const verifyResponse = vi.fn();
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockRejectedValue(new Error('network down')),
                getLocationHref: () => baseHref,
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.ERROR,
                assetType: ASSET_TYPE.SERVICE_WORKER,
                url: 'https://example.com/lib.js',
            })
        );
    });

    it('treats SKIPPED results as non-violations', async () => {
        const verifyResponse = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.SKIPPED,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyResponse),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('content')),
                getLocationHref: () => baseHref,
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });
});
