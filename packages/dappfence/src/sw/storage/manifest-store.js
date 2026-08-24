/**
 * Manifest Store Abstraction
 * Handles all Store operations with a clear separation of concerns
 *
 * Uses dependency injection: createManifestStore(Store) takes a
 * { get, set, delete } interface, making it testable with in-memory backends.
 */

import { calculateHash } from '../../core/crypto.js';
import { MODE } from '../../core/constants.js';

/**
 * Normalize manifest data from external sources (pure function).
 * Handles both enhanced format ({ files: {...}, metadata, mode, ... }) and
 * legacy flat format. Hashes are stored as-is in SRI form (the same format
 * the signer emits and HTML's Subresource Integrity uses), so no encoding
 * conversion happens here. Top-level fields other than `files` (mode,
 * metadata, and any future fields) are preserved as-is so consumers can
 * read them.
 *
 * Each entry in `files` may be a single hash string or an array of hash
 * strings. Arrays are used for CDN-served assets (e.g. analytics scripts)
 * whose content is not a build artifact and may vary across CDN regions or
 * provider releases — listing all known-good hashes lets any current version
 * pass verification while still blocking unexpected content.
 * @param {object} manifestData - Raw manifest data
 * @returns {object} Normalized manifest: files (fileKey -> hash[]), pathRules ([]),
 *   contentRules ([]), mode (MODE.REPORTING default)
 */
export const normalizeManifestData = (manifestData) => {
    const toArray = (entry) => {
        if (Array.isArray(entry)) return entry;
        if (typeof entry === 'string') return [entry];
        if (entry?.hash) return [entry.hash];
        return [];
    };

    const normalizedFiles = {};
    if (typeof manifestData === 'object') {
        // Enhanced format: { "files": { "/path/file.js": "sha256-..." }, "metadata": {...} }
        if (manifestData.files && typeof manifestData.files === 'object') {
            for (const [filePath, entry] of Object.entries(manifestData.files)) {
                normalizedFiles[filePath] = toArray(entry);
            }
        } else {
            // Legacy flat format: { "/path/file.js": "sha256-..." | { hash: "sha256-..." } }
            for (const [filePath, entry] of Object.entries(manifestData)) {
                normalizedFiles[filePath] = toArray(entry);
            }
        }
    }
    return {
        ...manifestData,
        files: normalizedFiles,
        pathRules: Array.isArray(manifestData?.pathRules) ? manifestData.pathRules : [],
        contentRules: Array.isArray(manifestData?.contentRules) ? manifestData.contentRules : [],
        mode: manifestData?.mode ?? MODE.REPORTING,
    };
};

// Trusted Manifest System constants
const TRUSTED_MANIFEST_KEY = 'trusted-manifest';
const VERIFICATION_RESULTS_KEY = 'verification-results';

// Trusted-manifest priority queue: newest-first.
// Primary cleanup: entries older than MAX_AGE_MS are pruned on each addLatest.
// Safety cap: MAX_MANIFESTS prevents unbounded growth if deployments are very frequent.
const MAX_MANIFESTS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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
     * Stored as a flat array `[{appVersion, manifest, storedAt}]`, newest first.
     * The full manifest object is retained so consumers can read `mode`,
     * `metadata`, and any future top-level fields.
     *
     * `cachedList` mirrors the persisted array and is populated lazily on the first
     * read, kept in sync by addLatest after its tx commits.
     */
    let cachedList = null;

    const readList = async () => {
        if (cachedList === null) {
            cachedList = (await database.get(TRUSTED_MANIFEST_KEY)) || [];
        }
        return cachedList;
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
                const now = Date.now();
                const deduped = list.filter((m) => m.appVersion !== appVersion);
                deduped.unshift({ appVersion, manifest, storedAt: now });
                const pruned = deduped.filter((m) => now - m.storedAt < MAX_AGE_MS);
                newList = pruned.slice(0, MAX_MANIFESTS);
                await tx.set(TRUSTED_MANIFEST_KEY, newList);
            });
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
