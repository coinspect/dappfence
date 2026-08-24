import { describe, it, expect, vi } from 'vitest';
import { createVerifier } from '../manifest/verifier.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FILE_HASH = 'sha256-abc123';
const MANIFEST_V1 = {
    files: { '/index.html': [FILE_HASH] },
    pathRules: [{ type: 'directory-index' }],
    contentRules: [],
    mode: 'protected',
};
const MANIFEST_V2 = {
    files: { '/index.html': ['sha256-newHash'] },
    pathRules: [{ type: 'directory-index' }],
    contentRules: [],
    mode: 'protected',
};
const INFO_V1 = { appVersion: 'v1', manifest: MANIFEST_V1 };

// Mock calculateHash so we control what hash a buffer produces.
// Use importOriginal so verification.js (also imported transitively) still gets
// recoverEthereumAddress and recoverPersonalSign from the real module.
vi.mock('../../core/crypto.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateHash: vi.fn(() => Promise.resolve(FILE_HASH)) };
});
import { calculateHash } from '../../core/crypto.js';

function makeSwContext({ clients = [{ id: 'client-1' }] } = {}) {
    return {
        getLocationHref: () => 'https://example.com/sw.js',
        matchAllClients: vi.fn(() => Promise.resolve(clients)),
    };
}

function makeAppStore() {
    return {
        verificationResultsStore: { add: vi.fn(() => Promise.resolve()) },
    };
}

function makeNav(path = '/') {
    return {
        method: 'GET',
        mode: 'navigate',
        destination: 'document',
        url: `https://example.com${path}`,
    };
}

function makeSubResource(path = '/app.js') {
    return {
        method: 'GET',
        mode: 'same-origin',
        destination: 'script',
        url: `https://example.com${path}`,
    };
}

function makeOkResponse() {
    const r = {
        ok: true,
        type: 'basic',
        arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(8))),
    };
    r.clone = vi.fn(() => makeOkResponse());
    return r;
}

function makeVerifier({
    latestManifest = INFO_V1,
    historicManifests = [],
    fetchResult = INFO_V1,
    clients = [{ id: 'client-1' }],
} = {}) {
    const fetchAndStoreManifest = vi.fn(() =>
        Promise.resolve({ status: VERIFICATION_STATUS.MATCH, ...fetchResult })
    );
    const storeManifestFromResponse = vi.fn(() =>
        Promise.resolve({ status: VERIFICATION_STATUS.MATCH, ...fetchResult })
    );
    const getManifestHistory = vi.fn(() => Promise.resolve(historicManifests));
    const swContext = makeSwContext({ clients });
    const appStore = makeAppStore();
    const config = { manifestUrl: 'https://example.com/integrity-manifest.json' };
    const manifestLoader = { fetchAndStoreManifest, storeManifestFromResponse, getManifestHistory };

    const { verifyResponse } = createVerifier({ swContext, appStore, config }, manifestLoader);

    const verify = (req, response, clientId = 'client-1') =>
        verifyResponse(req, response, clientId, latestManifest);

    return {
        verifyResponse,
        verify,
        fetchAndStoreManifest,
        storeManifestFromResponse,
        getManifestHistory,
        appStore,
        swContext,
    };
}

// ── gate checks ───────────────────────────────────────────────────────────────

describe('gate checks', () => {
    it('skips non-GET requests', async () => {
        const { verify } = makeVerifier();
        const req = {
            method: 'POST',
            mode: 'same-origin',
            destination: 'script',
            url: 'https://example.com/api',
        };
        const result = await verify(req, makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
    });

    it('allows POST navigate (form submission)', async () => {
        const { verify } = makeVerifier();
        const req = {
            method: 'POST',
            mode: 'navigate',
            destination: 'document',
            url: 'https://example.com/',
        };
        const response = makeOkResponse();
        const result = await verify(req, response);
        expect(result.status).not.toBe(VERIFICATION_STATUS.SKIPPED);
    });

    it('skips when destination is empty (programmatic fetch)', async () => {
        const { verify } = makeVerifier();
        const req = {
            method: 'GET',
            mode: 'same-origin',
            destination: '',
            url: 'https://example.com/app.js',
        };
        const result = await verify(req, makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
    });

    it('verifies the manifest file itself via storeManifestFromResponse', async () => {
        const { verify, storeManifestFromResponse, fetchAndStoreManifest } = makeVerifier();
        const req = makeSubResource('/integrity-manifest.json');
        const response = makeOkResponse();
        const result = await verify(req, response);
        expect(response.clone).toHaveBeenCalled();
        const clonedResponse = response.clone.mock.results[0].value;
        expect(storeManifestFromResponse).toHaveBeenCalledWith(clonedResponse);
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });
});

// ── manifest response clone ───────────────────────────────────────────────────

describe('manifest self-verification — response clone', () => {
    it('passes a clone to storeManifestFromResponse so the original body stays unconsumed', async () => {
        // storeManifestFromResponse calls .json(), consuming whatever response it receives.
        // Without .clone(), the original response body would be used up here, and
        // the fetch handler's event.respondWith(response) would throw "body already used".
        let originalConsumed = false;
        let cloneConsumed = false;

        const clonedResponse = {
            ok: true,
            type: 'basic',
            json: vi.fn(async () => {
                cloneConsumed = true;
                return {};
            }),
        };
        const response = {
            ok: true,
            type: 'basic',
            clone: vi.fn(() => clonedResponse),
            json: vi.fn(async () => {
                originalConsumed = true;
                return {};
            }),
            arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(8))),
        };

        const storeManifestFromResponse = vi.fn(async (r) => {
            await r.json();
            return { status: VERIFICATION_STATUS.MATCH, appVersion: 'v1', manifest: MANIFEST_V1 };
        });

        const { verifyResponse } = createVerifier(
            {
                swContext: makeSwContext(),
                appStore: makeAppStore(),
                config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
            },
            {
                storeManifestFromResponse,
                fetchAndStoreManifest: vi.fn(),
                getManifestHistory: vi.fn(() => Promise.resolve([])),
            }
        );

        await verifyResponse(
            makeSubResource('/integrity-manifest.json'),
            response,
            'client-1',
            null
        );

        expect(cloneConsumed).toBe(true);
        expect(originalConsumed).toBe(false);
    });
});

// ── step 2: latestManifest ────────────────────────────────────────────────────

describe('step 2 — latestManifest', () => {
    it('passes when file hash matches latestManifest', async () => {
        const { verify, fetchAndStoreManifest, getManifestHistory } = makeVerifier();
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(getManifestHistory).not.toHaveBeenCalled();
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('pins client to latestManifest on step-2 success', async () => {
        const { verifyResponse, fetchAndStoreManifest } = makeVerifier();
        const response = makeOkResponse();
        await verifyResponse(makeNav('/'), response, 'client-1', INFO_V1);

        // Second request (sub-resource, non-navigation) should use the pin without escalating.
        fetchAndStoreManifest.mockClear();
        const response2 = makeOkResponse();
        const result = await verifyResponse(
            makeSubResource('/index.html'),
            response2,
            'client-1',
            INFO_V1
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('does not pin when clientId is null', async () => {
        const { verifyResponse, fetchAndStoreManifest } = makeVerifier();
        await verifyResponse(makeNav('/'), makeOkResponse(), null, INFO_V1);
        await verifyResponse(makeSubResource('/index.html'), makeOkResponse(), null, INFO_V1);
        // Without pinning, step 2 is always re-evaluated (no escalation needed here since it passes).
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });
});

// ── step 1: pinned client ─────────────────────────────────────────────────────

describe('step 1 — pinned client', () => {
    it('uses pinned manifest for sub-resources, no escalation', async () => {
        const { verifyResponse, fetchAndStoreManifest, getManifestHistory } = makeVerifier();
        // Pin the client via a navigation.
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);

        fetchAndStoreManifest.mockClear();
        getManifestHistory.mockClear();

        // Sub-resource should use the pin directly.
        const result = await verifyResponse(
            makeSubResource('/index.html'),
            makeOkResponse(),
            'client-1',
            INFO_V1
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(getManifestHistory).not.toHaveBeenCalled();
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('returns violation without escalating when pinned manifest fails', async () => {
        const { verifyResponse, fetchAndStoreManifest } = makeVerifier();
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
        fetchAndStoreManifest.mockClear();

        // Simulate a file whose hash doesn't match the pinned manifest.
        // applyAction returns null on verify failure so the pipeline falls through
        // to NOT_FOUND_IN_MANIFEST — still a violation, just not escalated.
        calculateHash.mockResolvedValueOnce('sha256-tampered');
        const result = await verifyResponse(
            makeSubResource('/index.html'),
            makeOkResponse(),
            'client-1',
            INFO_V1
        );
        expect(result.status.isViolation).toBe(true);
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('bypasses pin for navigation requests', async () => {
        const { verifyResponse, fetchAndStoreManifest } = makeVerifier();
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
        fetchAndStoreManifest.mockClear();

        // Navigation bypasses pin and re-evaluates (step 2 passes here).
        const result = await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });
});

// ── step 3: historic manifests ────────────────────────────────────────────────

describe('step 3 — historic manifests', () => {
    it('falls through to historic manifests when latestManifest fails', async () => {
        const wrongManifest = { appVersion: 'v-wrong', manifest: MANIFEST_V2 };
        const { verify, getManifestHistory } = makeVerifier({
            latestManifest: wrongManifest,
            historicManifests: [INFO_V1],
        });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(getManifestHistory).toHaveBeenCalled();
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('skips historic manifest when its appVersion matches latestManifest (already tried)', async () => {
        const { verify, getManifestHistory, fetchAndStoreManifest } = makeVerifier({
            latestManifest: { appVersion: 'v-same', manifest: MANIFEST_V2 },
            historicManifests: [{ appVersion: 'v-same', manifest: MANIFEST_V2 }],
            fetchResult: INFO_V1,
        });
        // step 2 fails (MANIFEST_V2 has wrong hash), step 3 is same version so skipped,
        // step 4 returns INFO_V1 which matches.
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(getManifestHistory).toHaveBeenCalled();
        expect(fetchAndStoreManifest).toHaveBeenCalled();
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('pins client to historic manifest on step-3 success', async () => {
        const wrongManifest = { appVersion: 'v-wrong', manifest: MANIFEST_V2 };
        const { verifyResponse, fetchAndStoreManifest } = makeVerifier({
            latestManifest: wrongManifest,
            historicManifests: [INFO_V1],
        });
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', wrongManifest);
        fetchAndStoreManifest.mockClear();

        const result = await verifyResponse(
            makeSubResource('/index.html'),
            makeOkResponse(),
            'client-1',
            wrongManifest
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });
});

// ── step 4: network fetch ─────────────────────────────────────────────────────

describe('step 4 — fetchAndStoreManifest (terminal)', () => {
    it('fetches from network when steps 2 and 3 fail', async () => {
        const { verify, fetchAndStoreManifest } = makeVerifier({
            latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
            findByHashResult: null,
            fetchResult: INFO_V1,
        });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(fetchAndStoreManifest).toHaveBeenCalled();
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('returns violation when fresh manifest also fails', async () => {
        const { verify } = makeVerifier({
            latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
            findByHashResult: null,
            fetchResult: { appVersion: 'v-fresh', manifest: MANIFEST_V2 },
        });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(result.status.isViolation).toBe(true);
    });

    it('falls through to latestManifest result when fetchAndStoreManifest fails', async () => {
        const fetchAndStoreManifest = vi.fn(() =>
            Promise.resolve({
                status: VERIFICATION_STATUS.ERROR,
                fileKey: '/integrity-manifest.json',
            })
        );
        const { verifyResponse: verify } = createVerifier(
            {
                swContext: makeSwContext(),
                appStore: makeAppStore(),
                config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
            },
            { fetchAndStoreManifest, getManifestHistory: vi.fn(() => Promise.resolve([])) }
        );
        const result = await verify(makeNav('/'), makeOkResponse(), 'client-1', {
            appVersion: 'v-stale',
            manifest: MANIFEST_V2,
        });
        expect(result.status.isViolation).toBe(true);
    });

    it('pins client to fresh manifest after step 4', async () => {
        const { verifyResponse, fetchAndStoreManifest: fetch1 } = makeVerifier({
            latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
            findByHashResult: null,
            fetchResult: INFO_V1,
        });
        const staleInfo = { appVersion: 'v-stale', manifest: MANIFEST_V2 };
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', staleInfo);
        fetch1.mockClear();

        const result = await verifyResponse(
            makeSubResource('/index.html'),
            makeOkResponse(),
            'client-1',
            staleInfo
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(fetch1).not.toHaveBeenCalled();
    });
});

// ── pipeline action semantics ─────────────────────────────────────────────────

describe('pipeline action semantics', () => {
    it('DENIED_BY_RULE stops escalation — does not try historic or fetched manifests', async () => {
        const denyManifest = {
            appVersion: 'v-deny',
            manifest: {
                files: { '/index.html': [FILE_HASH] },
                contentRules: [{ action: { type: 'deny' } }],
                pathRules: [{ type: 'directory-index' }],
                mode: 'protected',
            },
        };
        const { verify, getManifestHistory, fetchAndStoreManifest } = makeVerifier({
            latestManifest: denyManifest,
        });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.DENIED_BY_RULE);
        expect(getManifestHistory).not.toHaveBeenCalled();
        expect(fetchAndStoreManifest).not.toHaveBeenCalled();
    });

    it('verify action returns MISMATCH (not NOT_FOUND_IN_MANIFEST) when hash does not match', async () => {
        calculateHash.mockResolvedValueOnce('sha256-tampered');
        const { verify } = makeVerifier();
        const result = await verify(makeSubResource('/index.html'), makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.actualHash).toBe('sha256-tampered');
        expect(result.expectedHashes).toEqual([FILE_HASH]);
    });

    it('transform action falls through (null) on mismatch, allowing subsequent actions to run', async () => {
        // The netlify-cdp transform finds no pattern to strip in the mock buffer,
        // so the transformed hash does not match FILE_HASH → handleTransform returns
        // null → pipeline continues to the verify action → MATCH.
        calculateHash
            .mockResolvedValueOnce('sha256-stripped-no-match') // hash after transform
            .mockResolvedValueOnce(FILE_HASH); // hash for verify fallback

        const transformManifest = {
            appVersion: 'v-transform',
            manifest: {
                files: { '/index.html': [FILE_HASH] },
                contentRules: [
                    { action: { type: 'transform', transform: 'netlify-cdp' } },
                    { action: { type: 'verify' } },
                ],
                pathRules: [{ type: 'directory-index' }],
                mode: 'protected',
            },
        };
        const { verify } = makeVerifier({ latestManifest: transformManifest });
        const result = await verify(makeNav('/'), makeOkResponse());
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });
});

// ── stale client pruning ──────────────────────────────────────────────────────

describe('stale client pruning', () => {
    it('calls matchAllClients after pinning', async () => {
        const { verifyResponse, swContext } = makeVerifier();
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
        await new Promise((r) => setTimeout(r, 0));
        expect(swContext.matchAllClients).toHaveBeenCalled();
    });

    it('evicts inactive clients so they re-escalate on next request', async () => {
        const swContext = makeSwContext({ clients: [] }); // client-1 not active
        const fetchAndStoreManifest = vi.fn(() =>
            Promise.resolve({ status: VERIFICATION_STATUS.MATCH, ...INFO_V1 })
        );
        const { verifyResponse } = createVerifier(
            {
                swContext,
                appStore: makeAppStore(),
                config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
            },
            { fetchAndStoreManifest, getManifestHistory: vi.fn(() => Promise.resolve([])) }
        );

        // First call pins client-1 (but pruning evicts it immediately).
        await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
        await new Promise((r) => setTimeout(r, 0));
        fetchAndStoreManifest.mockClear();

        // Second call (sub-resource) — client evicted, so no pin, escalates to step 4.
        const staleInfo = { appVersion: 'v-stale', manifest: MANIFEST_V2 };
        await verifyResponse(
            makeSubResource('/index.html'),
            makeOkResponse(),
            'client-1',
            staleInfo
        );
        expect(fetchAndStoreManifest).toHaveBeenCalled();
    });
});
