/**
 * Verification Results Store
 *
 * One IndexedDB row per non-SKIPPED verifier outcome, keyed by UUID. The UI
 * reads this via /sw-api/status to render per-status counts and the
 * "recent verifications" drawer.
 *
 * Retention runs lazily on add() but is rate-limited by PURGE_RATE_LIMIT_MS, so
 * a burst of fetches during a page load doesn't trigger a full-store scan per
 * event. The purge comprises two phases on a single getAll() snapshot:
 *   1. age-out MATCH rows older than RETENTION_MS, keeping the newest UI_SLICE
 *      rows globally so the UI drawer never goes empty; non-MATCH rows are
 *      preserved from age-out so audit evidence isn't lost to MATCH noise;
 *   2. hard ceiling: if total rows still exceed MAX_ROWS_TOTAL, the oldest
 *      rows are evicted regardless of status — the universal upper bound on
 *      IDB growth.
 *
 */

/** @typedef {import('../security-processor.js').SecurityEventDetails} SecurityEventDetails */
/** @typedef {import('./indexeddb.js').StoreHandle} StoreHandle */

/**
 * Persisted shape of a verifier outcome. `batchId` is the telemetry-batches
 * sentinel: `''` = unclaimed, uuid string = claimed into that batch.
 * @typedef {{
 *   id: string,
 *   appVersion?: string,
 *   timestamp: number,
 *   status: string,
 *   fileKey: string,
 *   reason?: string,
 *   expectedHashes?: string[],
 *   actualHash?: string,
 *   url?: string,
 *   destination?: string,
 *   httpStatus?: number,
 *   clientId?: string,
 *   assetType?: string,
 *   batchId: string,
 * }} VerdictRow
 */

const UI_SLICE = 100;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS_TOTAL = 10_000;
const PURGE_RATE_LIMIT_MS = 60_000;

/**
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createVerificationResultsStore(db) {
    let lastPurgeAt = 0;

    /**
     * @param {StoreHandle} verificationResults
     */
    async function purge(verificationResults) {
        const now = Date.now();
        if (now - lastPurgeAt < PURGE_RATE_LIMIT_MS) {
            return;
        }
        lastPurgeAt = now;

        const all = await verificationResults.getAll();
        const cutoff = now - RETENTION_MS;
        const newestIds = new Set(
            all
                .slice()
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, UI_SLICE)
                .map((r) => r.id)
        );
        const toDeleteIds = new Set(
            all
                .filter((r) => r.status === 'MATCH' && r.timestamp < cutoff && !newestIds.has(r.id))
                .map((r) => r.id)
        );
        const remaining = all.length - toDeleteIds.size;
        if (remaining > MAX_ROWS_TOTAL) {
            all.filter((r) => !toDeleteIds.has(r.id))
                .sort((a, b) => a.timestamp - b.timestamp)
                .slice(0, remaining - MAX_ROWS_TOTAL)
                .forEach((r) => toDeleteIds.add(r.id));
        }
        if (toDeleteIds.size === 0) {
            return;
        }
        await Promise.all(Array.from(toDeleteIds).map((id) => verificationResults.delete(id)));
    }

    return {
        /**
         * Every verdict row. Callers filter in memory (by batchId, appVersion,
         * etc.) in line with the storage-wide getAll+filter convention.
         * @returns {Promise<VerdictRow[]>}
         */
        async getAll() {
            return db.read(['verificationResults'], ({ verificationResults }) =>
                verificationResults.getAll()
            );
        },

        /**
         * Claimed verdicts grouped by batchId. Unclaimed rows (batchId === '')
         * are filtered out. Done in memory per the storage-wide getAll+filter
         * convention; the join table is small enough to let the caller look
         * up only the batchIds it cares about.
         * @returns {Promise<Map<string, VerdictRow[]>>}
         */
        async getByBatchId() {
            const all = await db.read(['verificationResults'], ({ verificationResults }) =>
                verificationResults.getAll()
            );
            const byBatchId = new Map();
            for (const v of all) {
                if (!v.batchId) continue;
                const list = byBatchId.get(v.batchId);
                if (list) {
                    list.push(v);
                } else {
                    byBatchId.set(v.batchId, [v]);
                }
            }
            return byBatchId;
        },

        /**
         * Return the latest UI_SLICE rows for the given appVersion, newest first.
         * Passing nullish returns rows with no appVersion (pre-manifest events).
         */
        async get(appVersion) {
            return db.read(['verificationResults'], async ({ verificationResults }) => {
                const all = await verificationResults.getAll();
                return all
                    .filter((r) => (appVersion ? r.appVersion === appVersion : !r.appVersion))
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, UI_SLICE);
            });
        },

        /**
         * Persist a verifier outcome as one row. Events landing before a
         * manifest is resolved (MANIFEST_UNTRUSTED, CONFIG_ERROR) store
         * appVersion as undefined — the UI's get(appVersion) can't surface
         * them, but telemetry still ships them.
         * @param {SecurityEventDetails} details
         */
        async add(details) {
            const row = {
                id: crypto.randomUUID(),
                appVersion: details.manifestInfo?.appVersion,
                timestamp: Date.now(),
                status: details.status.description,
                fileKey: details.fileKey,
                reason: details.reason,
                expectedHashes: details.expectedHashes,
                actualHash: details.actualHash,
                url: details.url,
                destination: details.destination,
                httpStatus: details.httpStatus,
                clientId: details.clientId,
                batchId: '',
            };
            await db.write(['verificationResults'], async ({ verificationResults }) => {
                await verificationResults.add(row);
                await purge(verificationResults);
            });
        },
    };
}
