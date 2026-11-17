/**
 * Telemetry batches store — one row per batch, metadata only. Events live in
 * verificationResults with `batchId === batch.id`; the caller joins at send
 * time. `sentAt` encodes the two states: undefined = waiting, number = sent.
 * Reads do getAll() + in-memory filter, matching the storage-wide decision
 * that one scan per rate-limited operation is cheaper than maintaining
 * indexes.
 */

import { VERIFICATION_STATUS_BY_NAME } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

/** @typedef {import('./verification-results-store.js').VerdictRow} VerdictRow */

/**
 * Batch row is pure metadata. The events are in `verificationResults` with
 * `batchId === batch.id`; the caller joins at send time.
 *
 * @typedef {{
 *   id: string,
 *   createdAt: number,
 *   sentAt?: number,
 *   priority: boolean,
 * }} BatchRecord
 *
 * @typedef {(verdicts: VerdictRow[]) => VerdictRow[]} SelectVerdicts
 *
 * Runs inside the readwrite tx; must be synchronous — any await on non-IDB
 * work (crypto, fetch, timers) auto-commits the tx. Returns the subset of
 * input to batch; storage pre-filters to unclaimed rows so the caller never
 * has to recheck batchId.
 */

const logger = createLogger();

const PURGE_RATE_LIMIT_MS = 60_000;

function retryKeyForStream(stream) {
    return `${stream.toUpperCase()}_RETRY_STATE_KEY`;
}

/**
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createTelemetryBatchesStore(db) {
    let lastPurgeAt = 0;
    const retryCache = new Map();

    return {
        /** @param {BatchRecord} batch */
        async add(batch) {
            await db.write(['telemetryBatches'], ({ telemetryBatches }) =>
                telemetryBatches.add(batch)
            );
        },

        /**
         * @param {string} id
         * @returns {Promise<BatchRecord | undefined>}
         */
        async get(id) {
            return db.read(['telemetryBatches'], ({ telemetryBatches }) =>
                telemetryBatches.get(id)
            );
        },

        async getAll() {
            return db.read(['telemetryBatches'], ({ telemetryBatches }) =>
                telemetryBatches.getAll()
            );
        },

        async getPending() {
            const all = await db.read(['telemetryBatches'], ({ telemetryBatches }) =>
                telemetryBatches.getAll()
            );
            return all.filter((b) => !b.sentAt);
        },

        /**
         * Atomic claim: read unclaimed verdicts, hand them to `selectVerdicts`,
         * write a batch row with the chosen subset, stamp batchId back on each.
         * Dedup, sort, projection, and size caps are the caller's job.
         * @param {SelectVerdicts} selectVerdicts
         * @returns {Promise<BatchRecord | null>}
         */
        async createBatch(selectVerdicts) {
            return db.write(
                ['verificationResults', 'telemetryBatches'],
                async ({ verificationResults, telemetryBatches }) => {
                    const allVerdicts = await verificationResults.getAll();
                    const unclaimedVerdicts = allVerdicts.filter((v) => !v.batchId);
                    if (unclaimedVerdicts.length === 0) {
                        logger.log('telemetryBatchesStore.createBatch: no unclaimed verdicts');
                        return null;
                    }

                    const claimedVerdicts = selectVerdicts(unclaimedVerdicts);
                    if (claimedVerdicts.length === 0) {
                        logger.log(
                            'telemetryBatchesStore.createBatch: selectVerdicts claimed none'
                        );
                        return null;
                    }

                    const batch = {
                        id: crypto.randomUUID(),
                        createdAt: Date.now(),
                        priority: claimedVerdicts.some(
                            (v) => VERIFICATION_STATUS_BY_NAME.get(v.status)?.isViolation
                        ),
                    };
                    await telemetryBatches.add(batch);
                    for (const verdict of claimedVerdicts) {
                        verdict.batchId = batch.id;
                        await verificationResults.put(verdict);
                    }
                    logger.log(
                        `telemetryBatchesStore.createBatch: batch ${batch.id} from ${claimedVerdicts.length} verdicts (priority=${batch.priority})`
                    );
                    return batch;
                }
            );
        },

        /**
         * Per-stream read of retry state. Cached — first read hits IDB,
         * subsequent reads hit the in-memory cache. Cache is refreshed by
         * `withRetryTxForStream` after a successful tx commit.
         * @param {string} stream
         * @returns {Promise<{attemptNumber: number, nextAttemptAt: number} | null>}
         */
        async getRetryStateForStream(stream) {
            try {
                if (retryCache.has(stream)) {
                    return retryCache.get(stream);
                }
                const val = await db.read(['settings'], ({ settings }) =>
                    settings.get(retryKeyForStream(stream))
                );
                retryCache.set(stream, val);
                return val;
            } catch (error) {
                logger.error(`Error reading retry key for stream: ${stream}`, error);
            }
            return null;
        },

        /**
         * Per-stream atomic tx across `telemetryBatches` + the stream's retry
         * row. The `retry` helper is bound to
         * `settings[retryKeyForStream(stream)]`, so each stream's backoff
         * state is isolated by name without the store having to enumerate
         * streams.
         * @template T
         * @param {string} stream
         * @param {(helpers: {
         *   telemetryBatches: {
         *     get: (id: string) => Promise<BatchRecord | undefined>,
         *     put: (batch: BatchRecord) => Promise<any>,
         *   },
         *   retry: {
         *     get: () => Promise<{ attemptNumber: number, nextAttemptAt: number } | undefined>,
         *     put: (val: { attemptNumber: number, nextAttemptAt: number }) => Promise<any>,
         *   },
         * }) => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async withRetryTxForStream(stream, fn) {
            const key = retryKeyForStream(stream);
            let latestRetry = null;
            const result = await db.write(
                ['telemetryBatches', 'settings'],
                async ({ telemetryBatches, settings }) => {
                    const helpers = {
                        telemetryBatches: {
                            get: async (id) => telemetryBatches.get(id),
                            put: async (batch) => telemetryBatches.put(batch),
                        },
                        retry: {
                            get: async () => settings.get(key),
                            put: async (val) => {
                                latestRetry = val;
                                return settings.put(val, key);
                            },
                        },
                    };
                    return await fn(helpers);
                }
            );
            if (latestRetry !== null) {
                retryCache.set(stream, latestRetry);
            }
            return result;
        },

        /**
         * Delete sent batches whose `sentAt` is older than `cutoffMs`. Rate-limited:
         * repeated calls within PURGE_RATE_LIMIT_MS collapse to a no-op since nothing
         * meaningful can go stale in that window (retention is in days).
         * The limiter resets on SW restart.
         * @param {number} cutoffMs
         */
        async purge(cutoffMs) {
            const now = Date.now();
            if (now - lastPurgeAt < PURGE_RATE_LIMIT_MS) {
                logger.log('telemetryBatchesStore.purge: rate-limited; skipping');
                return;
            }
            lastPurgeAt = now;
            await db.write(['telemetryBatches'], async ({ telemetryBatches }) => {
                const all = await telemetryBatches.getAll();
                const stale = all.filter((batch) => batch.sentAt && batch.sentAt < cutoffMs);
                if (stale.length === 0) {
                    logger.log('telemetryBatchesStore.purge: no stale sent batches');
                    return;
                }
                await Promise.all(stale.map((batch) => telemetryBatches.delete(batch.id)));
            });
        },

        async count() {
            return db.read(['telemetryBatches'], ({ telemetryBatches }) =>
                telemetryBatches.count()
            );
        },
    };
}
