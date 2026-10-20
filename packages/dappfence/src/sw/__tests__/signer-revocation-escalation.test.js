/**
 * Signer revocation — escalation layer.
 *
 * Policy: rotating the anchored identity does NOT revoke the previous signer's
 * manifests. The escalation search in createVerifier walks the full manifest
 * history and accepts the first MATCH, so a file vouched for only by the
 * previous signer keeps verifying after a rotation. That is intended: a
 * legitimate rotation must not retroactively break the old signer's files.
 *
 * Revocation is explicit: the new signer publishes a manifest with
 * `revokeManifests: true`, `addLatest` replaces the history with that single
 * entry, and from then on escalation has nothing from the old signer to fall
 * back to. This is how a leaked key is remediated.
 *
 * The store is real (in-memory backend), and `getManifestHistory` is wired to
 * `trustedManifestStore.getAll` exactly like manifest-loader does, so these
 * tests exercise the flag end to end rather than a hand-built history array.
 * Responses and hashes are real too — the body the verifier hashes and the hash
 * the manifest declares come from the same bytes.
 *
 * Store-layer coverage lives in signer-revocation-store.test.js.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    createVerifier,
    basicVerifyAgainstManifest,
    securityVerifyAgainstManifest,
} from '../manifest/security-verifier.js';
import { normalizeManifestData } from '../manifest/manifest-loader.js';
import { isRequestAllowed } from '../manifest/rules.js';
import { createManifestStore } from '../storage/manifest-store.js';
import { calculateHash } from '../../core/crypto.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const LOCATION_HREF = 'https://example.com/sw.js';

const ANCHORED = { signatureType: 'noble-secp256k1-recovered-eth', identity: '0xNEW' };
const RETIRED = { signatureType: 'noble-secp256k1-recovered-eth', identity: '0xLEAKED' };

const EVIL_BODY = 'window.drainWallet()';
const LEGIT_BODY = 'console.log("ok")';

const hashOf = (body) => calculateHash(new TextEncoder().encode(body));
const EVIL_HASH = await hashOf(EVIL_BODY);
const LEGIT_HASH = await hashOf(LEGIT_BODY);

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

function createInMemoryStorage() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        delete: async (key) => store.delete(key),
        withTx: async (fn) =>
            fn({
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
            }),
    };
}

function scriptRequest(path) {
    return {
        method: 'GET',
        mode: 'same-origin',
        destination: 'script',
        url: `https://example.com${path}`,
    };
}

function scriptResponse(body) {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
    });
}

/**
 * Plays out a rotation away from a leaked key:
 *   1. The attacker, holding RETIRED, gets a manifest listing /evil.js stored.
 *   2. The user accepts the rotation to ANCHORED.
 *   3. The new owner publishes a manifest that lists only /app.js — with or
 *      without `revokeManifests`, depending on the test.
 */
async function rotateAwayFromLeakedKey({ revokeManifests }) {
    const { trustedManifestStore, activeIdentityStore } =
        createManifestStore(createInMemoryStorage());

    await trustedManifestStore.addLatest(
        normalizeManifestData({ files: { '/evil.js': [EVIL_HASH] }, mode: 'protected' }),
        RETIRED
    );
    await activeIdentityStore.updateActiveIdentity(ANCHORED);
    await trustedManifestStore.addLatest(
        normalizeManifestData({
            files: { '/app.js': [LEGIT_HASH] },
            mode: 'protected',
            revokeManifests,
        }),
        ANCHORED
    );

    return trustedManifestStore;
}

function makeVerify(trustedManifestStore, strategy) {
    const manifestLoader = {
        // The network serves the same manifest the new owner already stored,
        // so the last escalation step adds nothing beyond what history holds.
        fetchAndStoreManifest: vi.fn(async () => ({
            status: VERIFICATION_STATUS.MATCH,
            ...(await trustedManifestStore.getLatest()),
        })),
        storeManifestFromResponse: vi.fn(),
        getManifestHistory: trustedManifestStore.getAll,
    };
    const { verifyResponse } = createVerifier(
        {
            swContext: {
                getLocationHref: () => LOCATION_HREF,
                matchAllClients: vi.fn(() => Promise.resolve([{ id: 'client-1' }])),
            },
            appStore: {
                verificationResultsStore: { add: vi.fn(() => Promise.resolve()) },
            },
            config: { manifestUrl: 'https://example.com/integrity-manifest.json' },
        },
        manifestLoader,
        strategy
    );
    return async (req, response) =>
        verifyResponse(req, response, 'client-1', await trustedManifestStore.getLatest());
}

describe.each(STRATEGIES)('escalation across a signer rotation — $name', ({ strategy }) => {
    describe('without revokeManifests', () => {
        it('still accepts a file only the previous signer vouched for', async () => {
            const store = await rotateAwayFromLeakedKey({ revokeManifests: false });
            const verify = makeVerify(store, strategy);

            const result = await verify(scriptRequest('/evil.js'), scriptResponse(EVIL_BODY));

            // The latest (ANCHORED) manifest doesn't list /evil.js, so the search
            // falls back to history and finds the RETIRED entry. By design.
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });
    });

    describe('with revokeManifests', () => {
        it('rejects a file only the previous signer vouched for', async () => {
            const store = await rotateAwayFromLeakedKey({ revokeManifests: true });
            const verify = makeVerify(store, strategy);

            const result = await verify(scriptRequest('/evil.js'), scriptResponse(EVIL_BODY));

            // History was replaced by the revoking manifest, so there is no
            // RETIRED entry left for the search to fall back to.
            expect(result.status).not.toBe(VERIFICATION_STATUS.MATCH);
        });

        it('still accepts a file the new signer vouched for', async () => {
            const store = await rotateAwayFromLeakedKey({ revokeManifests: true });
            const verify = makeVerify(store, strategy);

            const result = await verify(scriptRequest('/app.js'), scriptResponse(LEGIT_BODY));

            // Control: proves the rejection above isn't the harness rejecting everything.
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });
    });
});
