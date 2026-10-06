/**
 * Factory-level tests for createVerifier — shared orchestration between both
 * strategies (pinned-skip + 4-step escalation + stale client pruning +
 * manifest-URL self-verification + gate checks).
 *
 * Each test runs twice: once with the basic strategy and once with the security
 * strategy. Strategy-specific behavior (allow-rule pre-check, DENIED_BY_RULE
 * escalation, CSP header layering) lives in security-verifier.test.js; leaf
 * contracts live in basic-verifier.test.js and security-verifier.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createVerifier,
    basicVerifyAgainstManifest,
    securityVerifyAgainstManifest,
} from '../manifest/security-verifier.js';
import { isRequestAllowed } from '../manifest/rules.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

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

vi.mock('../../core/crypto.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateHash: vi.fn(() => Promise.resolve(FILE_HASH)) };
});
import { calculateHash } from '../../core/crypto.js';

beforeEach(() => {
    calculateHash.mockReset();
    calculateHash.mockResolvedValue(FILE_HASH);
});

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

const STRATEGIES = [
    {
        name: 'basic',
        strategy: { verifyAgainstManifest: basicVerifyAgainstManifest, isAllowed: () => false },
    },
    {
        name: 'security',
        strategy: {
            verifyAgainstManifest: securityVerifyAgainstManifest,
            isAllowed: isRequestAllowed,
        },
    },
];

describe.each(STRATEGIES)('createVerifier — $name strategy', ({ strategy }) => {
    function makeFactoryVerifier({
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
        const manifestLoader = {
            fetchAndStoreManifest,
            storeManifestFromResponse,
            getManifestHistory,
        };

        const { verifyResponse } = createVerifier(
            { swContext, appStore, config },
            manifestLoader,
            strategy
        );

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

    describe('gate checks', () => {
        it('skips non-GET requests', async () => {
            const { verify } = makeFactoryVerifier();
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
            const { verify } = makeFactoryVerifier();
            const req = {
                method: 'POST',
                mode: 'navigate',
                destination: 'document',
                url: 'https://example.com/',
            };
            const result = await verify(req, makeOkResponse());
            expect(result.status).not.toBe(VERIFICATION_STATUS.SKIPPED);
        });

        it('skips when destination is empty (programmatic fetch)', async () => {
            const { verify } = makeFactoryVerifier();
            const req = {
                method: 'GET',
                mode: 'same-origin',
                destination: '',
                url: 'https://example.com/app.js',
            };
            const result = await verify(req, makeOkResponse());
            expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
        });

        it('rewrites opaque executable responses (upgrade did not succeed)', async () => {
            const { verify } = makeFactoryVerifier();
            const response = { ok: false, type: 'opaque' };
            const req = {
                method: 'GET',
                mode: 'no-cors',
                destination: 'script',
                url: 'https://cdn.other.com/lib.js',
            };
            const result = await verify(req, response);
            expect(result.status).toBe(VERIFICATION_STATUS.REWRITE);
        });

        it('skips non-executable opaque responses', async () => {
            const { verify } = makeFactoryVerifier();
            const response = { ok: false, type: 'opaque' };
            const req = {
                method: 'GET',
                mode: 'no-cors',
                destination: 'image',
                url: 'https://cdn.other.com/logo.png',
            };
            const result = await verify(req, response);
            expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
        });

        it('skips non-ok sub-resources', async () => {
            const { verify } = makeFactoryVerifier();
            const response = { ok: false, type: 'basic', status: 404 };
            const req = makeSubResource('/missing.png');
            req.destination = 'image';
            const result = await verify(req, response);
            expect(result.status).toBe(VERIFICATION_STATUS.SKIPPED);
        });

        it('verifies the manifest file itself via storeManifestFromResponse', async () => {
            const { verify, storeManifestFromResponse, fetchAndStoreManifest } =
                makeFactoryVerifier();
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

    describe('manifest self-verification — response clone', () => {
        it('passes a clone to storeManifestFromResponse so the original body stays unconsumed', async () => {
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
                return {
                    status: VERIFICATION_STATUS.MATCH,
                    appVersion: 'v1',
                    manifest: MANIFEST_V1,
                };
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
                },
                strategy
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

    describe('step 2 — latestManifest', () => {
        it('passes when file hash matches latestManifest', async () => {
            const { verify, fetchAndStoreManifest, getManifestHistory } = makeFactoryVerifier();
            const result = await verify(makeNav('/'), makeOkResponse());
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(getManifestHistory).not.toHaveBeenCalled();
            expect(fetchAndStoreManifest).not.toHaveBeenCalled();
        });

        it('pins client to latestManifest on step-2 success', async () => {
            const { verifyResponse, fetchAndStoreManifest } = makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);

            fetchAndStoreManifest.mockClear();
            const result = await verifyResponse(
                makeSubResource('/index.html'),
                makeOkResponse(),
                'client-1',
                INFO_V1
            );
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(fetchAndStoreManifest).not.toHaveBeenCalled();
        });

        it('does not pin when clientId is null', async () => {
            const { verifyResponse, fetchAndStoreManifest } = makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), null, INFO_V1);
            await verifyResponse(makeSubResource('/index.html'), makeOkResponse(), null, INFO_V1);
            expect(fetchAndStoreManifest).not.toHaveBeenCalled();
        });
    });

    describe('step 1 — pinned client', () => {
        it('uses pinned manifest for sub-resources, no escalation', async () => {
            const { verifyResponse, fetchAndStoreManifest, getManifestHistory } =
                makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);

            fetchAndStoreManifest.mockClear();
            getManifestHistory.mockClear();

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

        // Characterizes the current pinning bug: pinned client + subresource MISMATCH
        // returns the violation without ever calling fetchAndStoreManifest. When the
        // bug is fixed (escalate on subresource MISMATCH), this test will flip to
        // expect fetchAndStoreManifest to be called.
        it('returns violation without escalating when pinned manifest fails', async () => {
            const { verifyResponse, fetchAndStoreManifest } = makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
            fetchAndStoreManifest.mockClear();

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
            const { verifyResponse, fetchAndStoreManifest } = makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
            fetchAndStoreManifest.mockClear();

            const result = await verifyResponse(
                makeNav('/'),
                makeOkResponse(),
                'client-1',
                INFO_V1
            );
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });
    });

    describe('step 3 — historic manifests', () => {
        it('falls through to historic manifests when latestManifest fails', async () => {
            const wrongManifest = { appVersion: 'v-wrong', manifest: MANIFEST_V2 };
            const { verify, getManifestHistory } = makeFactoryVerifier({
                latestManifest: wrongManifest,
                historicManifests: [INFO_V1],
            });
            const result = await verify(makeNav('/'), makeOkResponse());
            expect(getManifestHistory).toHaveBeenCalled();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });

        it('skips historic manifest when its appVersion matches latestManifest (already tried)', async () => {
            const { verify, getManifestHistory, fetchAndStoreManifest } = makeFactoryVerifier({
                latestManifest: { appVersion: 'v-same', manifest: MANIFEST_V2 },
                historicManifests: [{ appVersion: 'v-same', manifest: MANIFEST_V2 }],
                fetchResult: INFO_V1,
            });
            const result = await verify(makeNav('/'), makeOkResponse());
            expect(getManifestHistory).toHaveBeenCalled();
            expect(fetchAndStoreManifest).toHaveBeenCalled();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });

        it('pins client to historic manifest on step-3 success', async () => {
            const wrongManifest = { appVersion: 'v-wrong', manifest: MANIFEST_V2 };
            const { verifyResponse, fetchAndStoreManifest } = makeFactoryVerifier({
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

    describe('step 4 — fetchAndStoreManifest (terminal)', () => {
        it('fetches from network when steps 2 and 3 fail', async () => {
            const { verify, fetchAndStoreManifest } = makeFactoryVerifier({
                latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
                fetchResult: INFO_V1,
            });
            const result = await verify(makeNav('/'), makeOkResponse());
            expect(fetchAndStoreManifest).toHaveBeenCalled();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });

        it('returns violation when fresh manifest also fails', async () => {
            const { verify } = makeFactoryVerifier({
                latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
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
                { fetchAndStoreManifest, getManifestHistory: vi.fn(() => Promise.resolve([])) },
                strategy
            );
            const result = await verify(makeNav('/'), makeOkResponse(), 'client-1', {
                appVersion: 'v-stale',
                manifest: MANIFEST_V2,
            });
            expect(result.status.isViolation).toBe(true);
        });

        it('pins client to fresh manifest after step 4', async () => {
            const { verifyResponse, fetchAndStoreManifest: fetch1 } = makeFactoryVerifier({
                latestManifest: { appVersion: 'v-stale', manifest: MANIFEST_V2 },
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

    describe('stale client pruning', () => {
        it('calls matchAllClients after pinning', async () => {
            const { verifyResponse, swContext } = makeFactoryVerifier();
            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
            await new Promise((r) => setTimeout(r, 0));
            expect(swContext.matchAllClients).toHaveBeenCalled();
        });

        it('evicts inactive clients so they re-escalate on next request', async () => {
            const swContext = makeSwContext({ clients: [] });
            const fetchAndStoreManifest = vi.fn(() =>
                Promise.resolve({ status: VERIFICATION_STATUS.MATCH, ...INFO_V1 })
            );
            const { verifyResponse } = createVerifier(
                {
                    swContext,
                    appStore: makeAppStore(),
                    config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
                },
                { fetchAndStoreManifest, getManifestHistory: vi.fn(() => Promise.resolve([])) },
                strategy
            );

            await verifyResponse(makeNav('/'), makeOkResponse(), 'client-1', INFO_V1);
            await new Promise((r) => setTimeout(r, 0));
            fetchAndStoreManifest.mockClear();

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
});
