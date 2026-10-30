/**
 * Telemetry batches store — one row per batch, metadata only. Events live in
 * verificationResults with `batchId === batch.id`; the caller joins at send
 * time. `sentAt` encodes the two states: undefined = waiting, number = sent.
 * Reads do getAll() + in-memory filter, matching the storage-wide decision
 * that one scan per rate-limited operation is cheaper than maintaining
 * indexes.
 */

import { VERIFICATION_STATUS } from '../../core/constants.js';
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
const EVENTS_RETRY_STATE_KEY = 'EVENTS_RETRY_STATE_KEY';
const EVENTS_RETRY_DEFAULT = { attemptNumber: 0, nextAttemptAt: 0 };

/** @type {Set<string>} */
const VIOLATION_STATUSES = new Set(
    Object.values(VERIFICATION_STATUS)
        .filter((v) => v.isViolation)
        .map((v) => v.description)
);

/**
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createTelemetryBatchesStore(db) {
    let lastPurgeAt = 0;
    let cachedRetryState = null;

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
                        priority: claimedVerdicts.some((v) => VIOLATION_STATUSES.has(v.status)),
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
         * Flip all `ids` to sent AND reset retry state in a single tx — "we
         * succeeded" is the atomic unit. Array signature is required: a merged
         * POST must flip every contributing batch together.
         * @param {string[]} ids
         */
        async markSent(ids) {
            if (ids.length === 0) {
                logger.log('telemetryBatchesStore.markSent: empty id list; skipping');
                return;
            }
            await db.write(
                ['telemetryBatches', 'settings'],
                async ({ telemetryBatches, settings }) => {
                    const now = Date.now();
                    for (const id of ids) {
                        const batch = await telemetryBatches.get(id);
                        if (!batch) {
                            logger.log(
                                `telemetryBatchesStore.markSent: no batch for id ${id}; skipping`
                            );
                            continue;
                        }
                        batch.sentAt = now;
                        await telemetryBatches.put(batch);
                    }
                    cachedRetryState = EVENTS_RETRY_DEFAULT;
                    await settings.put(EVENTS_RETRY_DEFAULT, EVENTS_RETRY_STATE_KEY);
                }
            );
        },

        /**
         * Executor-level retry state for the events channel. Stored in the
         * `settings` object store but owned by this module since it tracks
         * batch-send progress, not per-install singletons.
         * @returns {Promise<{attemptNumber: number, nextAttemptAt: number}>}
         */
        async getRetryState() {
            if (cachedRetryState === null) {
                cachedRetryState = await db.read(['settings'], async ({ settings }) => {
                    const state = await settings.get(EVENTS_RETRY_STATE_KEY);
                    return state ?? EVENTS_RETRY_DEFAULT;
                });
            }
            return cachedRetryState;
        },

        /**
         * Bump attemptNumber + compute next backoff with jitter in one tx.
         * Caller supplies the policy (base/cap). Returns the new state.
         * @param {{baseMs: number, capMs: number}} policy
         * @returns {Promise<{attemptNumber: number, nextAttemptAt: number}>}
         */
        async bumpRetryState({ baseMs, capMs }) {
            return db.write(['settings'], async ({ settings }) => {
                const prev = (await settings.get(EVENTS_RETRY_STATE_KEY)) ?? EVENTS_RETRY_DEFAULT;
                const nextAttempt = prev.attemptNumber + 1;
                const base = Math.min(capMs, baseMs * 2 ** (nextAttempt - 1));
                const jitter = Math.random() * base * 0.5;
                const next = {
                    attemptNumber: nextAttempt,
                    nextAttemptAt: Date.now() + base + jitter,
                };
                cachedRetryState = next;
                await settings.put(next, EVENTS_RETRY_STATE_KEY);
                return next;
            });
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
