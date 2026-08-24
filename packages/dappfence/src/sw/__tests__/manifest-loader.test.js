import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createManifestLoader } from '../manifest/manifest-loader.js';
import { VERIFICATION_STATUS, ASSET_TYPE } from '../../core/constants.js';

// Control verifyManifestSignature without real secp256k1 crypto.
vi.mock('../manifest/verification.js', () => ({
    toPathname: () => '/manifest.json',
    verifyManifestSignature: vi.fn(),
}));

import { verifyManifestSignature } from '../manifest/verification.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST_URL = 'https://example.com/manifest.json';
const VALID_PAYLOAD = { files: { '/app.js': 'sha256-abc' }, mode: 'protected' };
const MANIFEST_INFO = { appVersion: 'v1', manifest: VALID_PAYLOAD };

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

function makeAppStore({ findByHashResult = null, addLatestResult = MANIFEST_INFO } = {}) {
    return {
        trustedManifestStore: {
            findByHash: vi.fn(() => Promise.resolve(findByHashResult)),
            addLatest: vi.fn(() => Promise.resolve(addLatestResult)),
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

// ── fetchAndStoreManifest ─────────────────────────────────────────────────────

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

        it('stores manifest payload and returns MATCH on valid signature', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const appStore = makeAppStore({
                addLatestResult: { appVersion: 'v-ok', manifest: VALID_PAYLOAD },
            });
            const result = await makeLoader({ appStore }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(result.appVersion).toBe('v-ok');
            expect(result.manifest).toEqual(VALID_PAYLOAD);
            expect(appStore.trustedManifestStore.addLatest).toHaveBeenCalledWith(VALID_PAYLOAD);
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
