/**
 * Manifest Store Abstraction
 * Handles all Store operations with a clear separation of concerns
 *
 * Uses dependency injection: createManifestStore(database) takes a
 * { db } interface, making it testable with in-memory backends.
 */

// Trusted Manifest System constants
const TRUSTED_MANIFEST_KEY = 'trusted-manifest';

// Trusted-manifest priority queue: newest-first.
// Primary cleanup: entries older than MAX_AGE_MS are pruned on each addLatest.
// Safety cap: MAX_MANIFESTS prevents unbounded growth if deployments are very frequent.
const MAX_MANIFESTS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Create all manifest database operations with an injected database backend.
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createManifestStore(db) {
    /**
     * Flat array `[{appVersion, signedEnvelope, manifest, storedAt}]`, newest
     * first. `cachedList` mirrors the persisted array, populated lazily and
     * kept in sync by addLatest after its tx commits.
     */
    let cachedList = null;

    const readList = async () => {
        if (cachedList === null) {
            cachedList =
                (await db.read(['manifests'], ({ manifests }) =>
                    manifests.get(TRUSTED_MANIFEST_KEY)
                )) || [];
        }
        return cachedList;
    };

    return {
        /**
         * @param {object} entry
         * @param {string} entry.appVersion - Deterministic identity derived
         *   from the signed envelope by the caller.
         * @param {object} entry.signedEnvelope - Raw `{pay, sig}` as received
         *   on the wire; retained for re-POST on server request.
         * @param {object} entry.manifest - Normalized manifest for SW use.
         */
        async addLatest({ appVersion, signedEnvelope, manifest }) {
            // Read-modify-write under a single transaction so concurrent
            // addLatest calls can't clobber each other's updates.
            let newList;
            await db.write(['manifests'], async ({ manifests }) => {
                const list = (await manifests.get(TRUSTED_MANIFEST_KEY)) || [];
                const now = Date.now();
                const deduped = list.filter((m) => m.appVersion !== appVersion);
                deduped.unshift({ appVersion, signedEnvelope, manifest, storedAt: now });
                const pruned = deduped.filter((m) => now - m.storedAt < MAX_AGE_MS);
                newList = pruned.slice(0, MAX_MANIFESTS);
                await manifests.put(newList, TRUSTED_MANIFEST_KEY);
            });
            cachedList = newList;
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

        /**
         * Returns the raw `{pay, sig}` envelope for the given appVersion, or
         * undefined if we don't have it (never seen or aged out).
         * @param {string} appVersion
         * @returns {Promise<object | undefined>}
         */
        async getSignedEnvelope(appVersion) {
            const list = await readList();
            const entry = list.find((m) => m.appVersion === appVersion);
            return entry?.signedEnvelope;
        },

        async getAll() {
            return readList();
        },
    };
}
