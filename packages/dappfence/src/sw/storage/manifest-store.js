/**
 * Manifest Store Abstraction
 * Handles all Store operations with a clear separation of concerns
 *
 * Uses dependency injection: createManifestStore(Store) takes a
 * { get, set, delete } interface, making it testable with in-memory backends.
 */

import { calculateHash } from '../../core/crypto.js';
import { normalizeManifestData } from '../manifest/operations.js';

// Trusted Manifest System constants
const TRUSTED_MANIFEST_KEY = 'trusted-manifest';
const VERIFICATION_RESULTS_KEY = 'verification-results';

// Trusted-manifest priority queue: newest-first, capped to MAX_MANIFESTS so
// the working set stays bounded across upgrades.
const MAX_MANIFESTS = 5;

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
 * @param {object} database - database backend with { get(key), set(key, value), delete(key) }
 */
export function createManifestStore(database) {
    /**
     * Trusted Manifest database Operations
     *
     * Stored as a flat array `[{appVersion, manifest}]`, newest first. The
     * full manifest object is retained so consumers can read `mode`,
     * `metadata`, and any future top-level fields.
     *
     * Two in-memory caches sit in front of IndexedDB, both per-store-instance
     * (i.e. per SW lifetime, since one createManifestStore call serves the
     * whole SW): `cachedList` mirrors the persisted array and `hashIndex`
     * indexes hashes -> appVersion. Both are populated lazily on first read
     * and kept in sync by addLatest after its tx commits. Persisting them
     * would duplicate state that's cheap to derive from <=5 manifests.
     */
    let cachedList = null;
    let hashIndex = null;

    const readList = async () => {
        if (cachedList === null) {
            cachedList = (await database.get(TRUSTED_MANIFEST_KEY)) || [];
        }
        return cachedList;
    };

    const buildHashIndex = (list) => {
        const index = {};
        // Iterate oldest -> newest so newer entries overwrite, matching
        // priority-queue semantics. Index points to the entry itself, so
        // findByHash can return both appVersion and manifest in one lookup.
        for (let i = list.length - 1; i >= 0; i--) {
            const entry = list[i];
            for (const hash of Object.values(entry.manifest.files || {}).flat()) {
                index[hash] = entry;
            }
        }
        return index;
    };

    const ensureHashIndex = async () => {
        if (hashIndex !== null) {
            return hashIndex;
        }
        hashIndex = buildHashIndex(await readList());
        return hashIndex;
    };

    const trustedManifestStore = {
        async addLatest(rawManifest) {
            // Normalize raw input (mode/metadata/future fields preserved,
            // files re-keyed to hex) before persisting. The appVersion is
            // a deterministic synthetic key derived from the manifest
            // content; same content -> same key, so re-adding dedups and
            // promotes to the front.
            const manifest = normalizeManifestData(rawManifest);
            const appVersion = await createSyntheticAppVersion(manifest);
            // Read-modify-write under a single transaction so concurrent
            // addLatest calls can't clobber each other's updates. Read from
            // the tx (not cachedList) so the inner read sees the committed state,
            // including any concurrent writer's update.
            let newList;
            await database.withTx(async (tx) => {
                const list = (await tx.get(TRUSTED_MANIFEST_KEY)) || [];
                // Drop any existing entry for this appVersion — re-adding
                // bumps it to the front rather than producing a duplicate.
                const deduped = list.filter((m) => m.appVersion !== appVersion);
                deduped.unshift({ appVersion, manifest });
                newList = deduped.slice(0, MAX_MANIFESTS);
                await tx.set(TRUSTED_MANIFEST_KEY, newList);
            });
            // Refresh cache from the just-committed state; invalidate the
            // hash index so the next findByHash rebuilds.
            cachedList = newList;
            hashIndex = null;
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

        /**
         * Look up a stored manifest by any file's content hash.
         * @param {string} fileHash - hex SHA-256 of file content
         * @returns {Promise<{appVersion: string, manifest: object} | null>}
         */
        async findByHash(fileHash) {
            const index = await ensureHashIndex();
            return index[fileHash] ?? null;
        },
    };

    /**
     * Verification Results database Operations
     */
    const verificationResultsStore = {
        async get(appVersion) {
            const allResults = (await database.get(VERIFICATION_RESULTS_KEY)) || {};
            return allResults[appVersion] || [];
        },

        async add(appVersion, result) {
            const allResults = (await database.get(VERIFICATION_RESULTS_KEY)) || {};
            if (!allResults[appVersion]) {
                allResults[appVersion] = [];
            }

            allResults[appVersion].push(result);

            // Keep only last 100 results per app version to avoid unbounded growth
            if (allResults[appVersion].length > 100) {
                allResults[appVersion] = allResults[appVersion].slice(-100);
            }

            await database.set(VERIFICATION_RESULTS_KEY, allResults);
        },
    };

    return {
        trustedManifestStore,
        verificationResultsStore,
    };
}
