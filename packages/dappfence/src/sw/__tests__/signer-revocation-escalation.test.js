/**
 * Signer revocation — escalation layer.
 *
 * `addLatest` stamps every stored entry with { signatureType, signerIdentity }
 * (storage/manifest-store.js), but no reader consults them. The escalation
 * search in createVerifier walks the whole manifest history and accepts the
 * first MATCH, so a file vouched for only by a retired key still verifies after
 * the anchor has rotated away from it. Rotating the anchor is the standard
 * response to a leaked signing key; it has to stop honoring that key's
 * manifests or it remediates nothing.
 *
 * Real Response objects and real hashing throughout — the body the verifier
 * hashes and the hash the manifest declares come from the same bytes, so
 * nothing here depends on a stubbed digest.
 *
 * Store-layer coverage lives in signer-revocation-store.test.js.
 *
 * STATUS: the two "rejects" tests FAIL against the current implementation.
 * They describe the intended behavior, not the shipped behavior. The two
 * "still accepts" tests pass and exist to prove the harness is not simply
 * rejecting everything.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    createVerifier,
    basicVerifyAgainstManifest,
    securityVerifyAgainstManifest,
} from '../manifest/security-verifier.js';
import { normalizeManifestData } from '../manifest/manifest-loader.js';
import { isRequestAllowed } from '../manifest/rules.js';
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

const entry = (appVersion, files, signer) => ({
    appVersion,
    manifest: normalizeManifestData({ files, mode: 'protected' }),
    storedAt: Date.now(),
    signatureType: signer.signatureType,
    signerIdentity: signer.identity,
});

// What the attacker got signed while they held the leaked key.
const EVIL_ENTRY = entry('v-evil', { '/evil.js': [EVIL_HASH] }, RETIRED);

// The post-rotation manifest. Does not list /evil.js at all.
const CURRENT_ENTRY = entry('v-new', { '/app.js': [LEGIT_HASH] }, ANCHORED);

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

describe.each(STRATEGIES)(
    'escalation must not fall back to a retired signer — $name',
    ({ strategy }) => {
        function makeVerifier() {
            const manifestLoader = {
                // After a rotation the bootstrap config disagrees with the
                // anchor, so a fresh fetch cannot produce a usable manifest.
                fetchAndStoreManifest: vi.fn(() =>
                    Promise.resolve({
                        status: VERIFICATION_STATUS.MANIFEST_UNTRUSTED,
                        reason: 'SIGNER_CHANGED',
                    })
                ),
                storeManifestFromResponse: vi.fn(),
                getManifestHistory: vi.fn(() => Promise.resolve([CURRENT_ENTRY, EVIL_ENTRY])),
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
            return (req, response) => verifyResponse(req, response, 'client-1', CURRENT_ENTRY);
        }

        it('rejects a file that only the retired signer vouched for', async () => {
            const verify = makeVerifier();

            const result = await verify(scriptRequest('/evil.js'), scriptResponse(EVIL_BODY));

            // Today: MATCH — the escalation loop reaches EVIL_ENTRY and accepts it.
            expect(result.status).not.toBe(VERIFICATION_STATUS.MATCH);
        });

        it('still accepts a file the anchored signer vouched for', async () => {
            const verify = makeVerifier();

            const result = await verify(scriptRequest('/app.js'), scriptResponse(LEGIT_BODY));

            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        });
    }
);
