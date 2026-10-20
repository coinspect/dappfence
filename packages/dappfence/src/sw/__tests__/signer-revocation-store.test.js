/**
 * Signer revocation — store layer.
 *
 * `addLatest` stamps every entry with { signatureType, signerIdentity }
 * (storage/manifest-store.js), but no reader consults them, so manifests
 * produced by a key that is no longer the anchored identity stay trusted.
 * Rotating the anchor is the standard response to a leaked signing key; it has
 * to stop honoring that key's manifests or it remediates nothing.
 *
 * These tests cover the three reads the escalation search consumes, plus the
 * requirement that filtering stays non-destructive. The search that consumes
 * them is covered in signer-revocation-escalation.test.js.
 *
 * STATUS: these FAIL against the current implementation. They describe the
 * intended behavior, not the shipped behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';

const ANCHORED = { signatureType: 'noble-secp256k1-recovered-eth', identity: '0xNEW' };
const RETIRED = { signatureType: 'noble-secp256k1-recovered-eth', identity: '0xLEAKED' };

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

describe('trustedManifestStore — retired signers', () => {
    let trustedManifestStore;
    let activeIdentityStore;

    beforeEach(() => {
        ({ trustedManifestStore, activeIdentityStore } =
            createManifestStore(createInMemoryStorage()));
    });

    it('getAll omits manifests signed by anyone but the anchored identity', async () => {
        await trustedManifestStore.addLatest({ files: { '/evil.js': ['h'] } }, RETIRED);
        await activeIdentityStore.updateActiveIdentity(ANCHORED);
        await trustedManifestStore.addLatest({ files: { '/app.js': ['h2'] } }, ANCHORED);

        const all = await trustedManifestStore.getAll();

        expect(all.map((m) => m.signerIdentity)).toEqual([ANCHORED.identity]);
    });

    it('getLatest does not stand in a retired signer when the anchor has stored nothing', async () => {
        await trustedManifestStore.addLatest({ files: { '/evil.js': ['h'] } }, RETIRED);
        await activeIdentityStore.updateActiveIdentity(ANCHORED);

        expect(await trustedManifestStore.getLatest()).toBeUndefined();
    });

    it('get(appVersion) does not resolve a retired signer’s manifest', async () => {
        const { appVersion } = await trustedManifestStore.addLatest(
            { files: { '/evil.js': ['h'] } },
            RETIRED
        );
        await activeIdentityStore.updateActiveIdentity(ANCHORED);

        expect(await trustedManifestStore.get(appVersion)).toBeUndefined();
    });

    it('keeps serving manifests once the anchor is rotated back to their signer', async () => {
        await trustedManifestStore.addLatest({ files: { '/a.js': ['h'] } }, RETIRED);
        await activeIdentityStore.updateActiveIdentity(ANCHORED);
        expect(await trustedManifestStore.getAll()).toHaveLength(0);

        // Filtering must be non-destructive — the entries are ignored while a
        // different identity is anchored, not deleted.
        await activeIdentityStore.updateActiveIdentity(RETIRED);
        expect(await trustedManifestStore.getAll()).toHaveLength(1);
    });
});
