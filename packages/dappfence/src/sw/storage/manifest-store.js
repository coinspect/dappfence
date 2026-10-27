/**
 * Manifest Store Abstraction
 * Handles all Store operations with a clear separation of concerns
 *
 * Uses dependency injection: createManifestStore(database) takes a
 * { db } interface, making it testable with in-memory backends.
 */

import { calculateHash } from '../../core/crypto.js';

// Trusted Manifest System constants
const TRUSTED_MANIFEST_KEY = 'trusted-manifest';

// Trusted-manifest priority queue: newest-first.
// Primary cleanup: entries older than MAX_AGE_MS are pruned on each addLatest.
// Safety cap: MAX_MANIFESTS prevents unbounded growth if deployments are very frequent.
const MAX_MANIFESTS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Synthesize a deterministic appVersion from manifest content. Strips the
 * `sha256-` encoding prefix before truncating, so the 16-char tail is pure
 * entropy (~96 bits of base64) rather than 9 payload chars after a fixed
 * prefix. Same content -> same key, which is how to addLatest dedups.
 */
const createSyntheticAppVersion = async (manifestData) => {
    const manifestStr = JSON.stringify(manifestData);
    const manifestHash = await calculateHash(new TextEncoder().encode(manifestStr));
    const rawHash = manifestHash.replace(/^sha256-/, '');
    return `manifest-${rawHash.substring(0, 16)}`;
};

/**
 * Create all manifest database operations with an injected database backend.
 * @param {import('./indexeddb.js').Database} db
 */
export function createManifestStore(db) {
    /**
     * Trusted Manifest database Operations
     *
     * Stored as a flat array `[{appVersion, manifest, storedAt}]`, newest first.
     * The full manifest object is retained so consumers can read `mode`,
     * `metadata`, and any future top-level fields. Callers pass in
     * already-normalized manifests (see manifest-loader.normalizeManifestData);
     * the store does not reshape input.
     *
     * `cachedList` mirrors the persisted array and is populated lazily on the
     * first read, kept in sync by addLatest after its tx commits.
     */
    let cachedList = null;

    const readList = async () => {
        if (cachedList === null) {
            cachedList = (await db(({ manifests }) => manifests.get(TRUSTED_MANIFEST_KEY))) || [];
        }
        return cachedList;
    };

    return {
        async addLatest(manifest) {
            const appVersion = await createSyntheticAppVersion(manifest);
            // Read-modify-write under a single transaction so concurrent
            // addLatest calls can't clobber each other's updates.
            let newList;
            await db(
                async ({ manifests }) => {
                    const list = (await manifests.get(TRUSTED_MANIFEST_KEY)) || [];
                    const now = Date.now();
                    const deduped = list.filter((m) => m.appVersion !== appVersion);
                    deduped.unshift({ appVersion, manifest, storedAt: now });
                    const pruned = deduped.filter((m) => now - m.storedAt < MAX_AGE_MS);
                    newList = pruned.slice(0, MAX_MANIFESTS);
                    await manifests.put(newList, TRUSTED_MANIFEST_KEY);
                },
                { mode: 'readwrite' }
            );
            cachedList = newList;
            return { appVersion, manifest };
        },

        async getLatest() {
            const list = await readList();
            if (list.length === 0) {
                return undefined;
            }
            return list[0];
        },

        async get(appVersion) {
            const list = await readList();
            const entry = list.find((m) => m.appVersion === appVersion);
            return entry?.manifest;
        },

        async getAll() {
            return readList();
        },
    };
}
