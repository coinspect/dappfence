import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createManifestLoader, normalizeManifestData } from '../manifest/manifest-loader.js';
import { VERIFICATION_STATUS, ASSET_TYPE } from '../../core/constants.js';

vi.mock('../manifest/verification.js', () => ({
    toPathname: () => '/manifest.json',
    verifyManifestSignature: vi.fn(),
}));

import { verifyManifestSignature } from '../manifest/verification.js';

const MANIFEST_URL = 'https://example.com/manifest.json';
const VALID_PAYLOAD = { files: { '/app.js': 'sha256-abc' }, mode: 'protected' };
const MANIFEST_INFO = { appVersion: 'v1', manifest: normalizeManifestData(VALID_PAYLOAD) };

function makeConfig(overrides = {}) {
    return {
        manifestUrl: MANIFEST_URL,
        manifestSignatureType: 'secp256k1',
        manifestSignatureIdentity: '0xABCDEF',
        ...overrides,
    };
}

function makeOkResponse(json) {
    return { ok: true, status: 200, json: () => Promise.resolve(json) };
}

function makeSwContext({
    fetchResult = makeOkResponse({ pay: VALID_PAYLOAD, sig: 'sig' }),
    clients = [],
} = {}) {
    return {
        getLocationHref: () => 'https://example.com/sw.js',
        fetch: vi.fn(() => Promise.resolve(fetchResult)),
        matchAllClients: vi.fn(() => Promise.resolve(clients)),
    };
}

function makeAppStore({ addLatestResult = MANIFEST_INFO } = {}) {
    return {
        trustedManifestStore: {
            addLatest: vi.fn(() => Promise.resolve(addLatestResult)),
            getLatest: vi.fn(() => Promise.resolve(undefined)),
            getAll: vi.fn(() => Promise.resolve([])),
        },
    };
}

function makeLoader({ config, swContext, appStore } = {}) {
    return createManifestLoader({
        config: config ?? makeConfig(),
        swContext: swContext ?? makeSwContext(),
        appStore: appStore ?? makeAppStore(),
    });
}

describe('fetchAndStoreManifest', () => {
    beforeEach(() => vi.clearAllMocks());

    describe('config validation', () => {
        it('returns CONFIG_ERROR when manifestUrl is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestUrl: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
        });

        it('returns CONFIG_ERROR when manifestSignatureType is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestSignatureType: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
        });

        it('returns CONFIG_ERROR when manifestSignatureIdentity is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestSignatureIdentity: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
        });
    });

    describe('fetch errors', () => {
        it('returns ERROR with fileKey when response is not ok', async () => {
            const swContext = makeSwContext({
                fetchResult: { ok: false, status: 404, statusText: 'Not Found' },
            });
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns ERROR with fileKey when response is null', async () => {
            const swContext = makeSwContext({ fetchResult: null });
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns ERROR when fetch throws', async () => {
            const swContext = makeSwContext();
            swContext.fetch.mockRejectedValue(new Error('network error'));
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('fetches with no-cache and dappfence header', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(swContext.fetch).toHaveBeenCalledWith(
                MANIFEST_URL,
                expect.objectContaining({
                    cache: 'no-cache',
                    headers: expect.objectContaining({ 'x-dappfence': 'manifest-load' }),
                })
            );
        });
    });

    describe('signature verification', () => {
        it('returns violation enriched with assetType and fileKey when signature is a mismatch', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MISMATCH,
                expectedHashes: ['addr-expected'],
                actualHash: 'addr-got',
            });
            const result = await makeLoader().fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns UNSUPPORTED_SIGNATURE violation with assetType and fileKey', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE,
            });
            const result = await makeLoader().fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('normalizes the payload before handing it to the store', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const appStore = makeAppStore({
                addLatestResult: {
                    appVersion: 'v-ok',
                    manifest: normalizeManifestData(VALID_PAYLOAD),
                },
            });
            const result = await makeLoader({ appStore }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(result.appVersion).toBe('v-ok');
            expect(appStore.trustedManifestStore.addLatest).toHaveBeenCalledWith(
                normalizeManifestData(VALID_PAYLOAD)
            );
        });
    });

    describe('single-flight deduplication', () => {
        it('issues only one fetch for concurrent calls', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            const loader = makeLoader({ swContext });
            const [r1, r2] = await Promise.all([
                loader.fetchAndStoreManifest(),
                loader.fetchAndStoreManifest(),
            ]);
            expect(swContext.fetch).toHaveBeenCalledTimes(1);
            expect(r1.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(r2.status).toBe(VERIFICATION_STATUS.MATCH);
        });

        it('issues a new fetch after the previous in-flight call settles', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            const loader = makeLoader({ swContext });
            await loader.fetchAndStoreManifest();
            await loader.fetchAndStoreManifest();
            expect(swContext.fetch).toHaveBeenCalledTimes(2);
        });
    });
});

describe('resolveLatest', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns cached manifest without fetching when store has one', async () => {
        const cached = { appVersion: 'v-cache', manifest: normalizeManifestData(VALID_PAYLOAD) };
        const appStore = makeAppStore();
        appStore.trustedManifestStore.getLatest.mockResolvedValue(cached);
        const swContext = makeSwContext();
        const result = await makeLoader({ appStore, swContext }).resolveLatest();
        expect(result).toBe(cached);
        expect(swContext.fetch).not.toHaveBeenCalled();
    });

    it('falls back to fetch when store is empty', async () => {
        verifyManifestSignature.mockReturnValue({
            status: VERIFICATION_STATUS.MATCH,
            payload: VALID_PAYLOAD,
        });
        const swContext = makeSwContext();
        const result = await makeLoader({ swContext }).resolveLatest();
        expect(swContext.fetch).toHaveBeenCalledTimes(1);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });
});

describe('normalizeManifestData', () => {
    it('accepts enhanced format and returns files as array of hashes', () => {
        const result = normalizeManifestData({
            files: { '/app.js': 'sha256-abc' },
            mode: 'protected',
        });
        expect(result.files).toEqual({ '/app.js': ['sha256-abc'] });
        expect(result.mode).toBe('protected');
        expect(result.pathRules).toEqual([]);
    });

    it('preserves array hashes as-is', () => {
        const result = normalizeManifestData({
            files: { '/cdn.js': ['sha256-a', 'sha256-b'] },
        });
        expect(result.files['/cdn.js']).toEqual(['sha256-a', 'sha256-b']);
    });

    it('accepts { hash } object form', () => {
        const result = normalizeManifestData({
            files: { '/a.js': { hash: 'sha256-x' } },
        });
        expect(result.files['/a.js']).toEqual(['sha256-x']);
    });

    it('accepts legacy flat map when there is no `files` key', () => {
        const result = normalizeManifestData({ '/a.js': 'sha256-a', '/b.js': 'sha256-b' });
        expect(result.files).toEqual({ '/a.js': ['sha256-a'], '/b.js': ['sha256-b'] });
    });

    it('defaults mode to REPORTING when absent', () => {
        const result = normalizeManifestData({ files: {} });
        expect(result.mode).toBe('reporting');
    });

    it('preserves pathRules', () => {
        const rules = [{ type: 'directory-index' }];
        const result = normalizeManifestData({ files: {}, pathRules: rules });
        expect(result.pathRules).toBe(rules);
    });

    it('returns a safe empty shape for non-objects', () => {
        expect(normalizeManifestData(42)).toEqual(
            expect.objectContaining({ files: {}, pathRules: [], mode: 'reporting' })
        );
        expect(normalizeManifestData(undefined)).toEqual(
            expect.objectContaining({ files: {}, pathRules: [], mode: 'reporting' })
        );
    });
});
