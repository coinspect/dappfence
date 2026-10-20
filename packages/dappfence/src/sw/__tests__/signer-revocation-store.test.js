/**
 * Signer revocation — store layer.
 *
 * Policy: rotating the anchored identity does NOT revoke the previous signer's
 * manifests. The old signer was trusted when those manifests were stored, and a
 * legitimate rotation must not retroactively break files they vouched for. The
 * only thing that removes old entries is a manifest carrying
 * `revokeManifests: true`, which makes `addLatest` replace the whole list
 * instead of prepending.
 *
 * For a leaked key, that means the new owner signs their first post-rotation
 * manifest with `revokeManifests: true`; storing it drops everything the leaked
 * key produced.
 *
 * `updateActiveIdentity` stands in for the user accepting a rotation.
 *
 * The escalation search that consumes these reads is covered in
 * signer-revocation-escalation.test.js.
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

    describe('rotation alone keeps the previous signer trusted', () => {
        it('getAll returns entries from both signers, newest first', async () => {
            await trustedManifestStore.addLatest({ files: { '/old.js': ['h'] } }, RETIRED);
            await activeIdentityStore.updateActiveIdentity(ANCHORED);
            await trustedManifestStore.addLatest({ files: { '/app.js': ['h2'] } }, ANCHORED);

            const all = await trustedManifestStore.getAll();

            expect(all.map((m) => m.signerIdentity)).toEqual([ANCHORED.identity, RETIRED.identity]);
        });

        it('getLatest returns the previous signer’s entry until the new signer stores one', async () => {
            await trustedManifestStore.addLatest({ files: { '/old.js': ['h'] } }, RETIRED);
            await activeIdentityStore.updateActiveIdentity(ANCHORED);

            const latest = await trustedManifestStore.getLatest();

            expect(latest.signerIdentity).toBe(RETIRED.identity);
        });

        it('get(appVersion) still resolves the previous signer’s manifest', async () => {
            const { appVersion } = await trustedManifestStore.addLatest(
                { files: { '/old.js': ['h'] } },
                RETIRED
            );
            await activeIdentityStore.updateActiveIdentity(ANCHORED);

            expect(await trustedManifestStore.get(appVersion)).toEqual({
                files: { '/old.js': ['h'] },
            });
        });
    });

    describe('revokeManifests from the new signer drops the previous signer', () => {
        it('getAll keeps only the revoking entry', async () => {
            await trustedManifestStore.addLatest({ files: { '/old.js': ['h'] } }, RETIRED);
            await activeIdentityStore.updateActiveIdentity(ANCHORED);
            await trustedManifestStore.addLatest(
                { files: { '/app.js': ['h2'] }, revokeManifests: true },
                ANCHORED
            );

            const all = await trustedManifestStore.getAll();

            expect(all.map((m) => m.signerIdentity)).toEqual([ANCHORED.identity]);
        });

        it('get(appVersion) no longer resolves the previous signer’s manifest', async () => {
            const { appVersion } = await trustedManifestStore.addLatest(
                { files: { '/old.js': ['h'] } },
                RETIRED
            );
            await activeIdentityStore.updateActiveIdentity(ANCHORED);
            await trustedManifestStore.addLatest(
                { files: { '/app.js': ['h2'] }, revokeManifests: true },
                ANCHORED
            );

            expect(await trustedManifestStore.get(appVersion)).toBeUndefined();
        });

        it('later non-revoking manifests do not bring the previous signer back', async () => {
            await trustedManifestStore.addLatest({ files: { '/old.js': ['h'] } }, RETIRED);
            await activeIdentityStore.updateActiveIdentity(ANCHORED);
            await trustedManifestStore.addLatest(
                { files: { '/app.js': ['h2'] }, revokeManifests: true },
                ANCHORED
            );
            await trustedManifestStore.addLatest({ files: { '/app.js': ['h3'] } }, ANCHORED);

            const all = await trustedManifestStore.getAll();

            expect(all.map((m) => m.signerIdentity)).toEqual([
                ANCHORED.identity,
                ANCHORED.identity,
            ]);
        });
    });
});
