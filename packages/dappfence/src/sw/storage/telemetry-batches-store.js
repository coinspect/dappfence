/**
 * Telemetry batches store — one row per batch, self-contained `events[]`
 * envelope. `sentAt` field encodes the two states: undefined = waiting,
 * number = sent. Both this store and verificationResults are index-less;
 * reads do getAll() + in-memory filter, matching the storage-wide decision
 * that one scan per rate-limited operation is cheaper than maintaining
 * indexes.
 */

import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

/**
 * @typedef {{
 *   id: string,
 *   createdAt: number,
 *   sentAt?: number,
 *   events: object[],
 *   priority: boolean,
 * }} BatchRecord
 */

const logger = createLogger();

const PURGE_RATE_LIMIT_MS = 60_000;

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

    /**
     * 16-hex SHA-256 prefix over the identity tuple. JSON.stringify avoids
     * delimiter injection via user-controlled `fileKey` / `actualHash`.
     * @param {{status: string, fileKey: string, assetType?: string, reason?: string, actualHash?: string, expectedHashes?: string[]}} row
     */
    async function eventKey(row) {
        const identity = JSON.stringify([
            row.assetType ?? null,
            row.status,
            row.reason ?? null,
            row.fileKey,
            row.expectedHashes ?? null,
            row.actualHash ?? null,
        ]);
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
        return Array.from(new Uint8Array(bytes).subarray(0, 8), (b) =>
            b.toString(16).padStart(2, '0')
        ).join('');
    }

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
         * Atomic cross-store: dedup unclaimed verificationResults rows into a
         * new batch and stamp `batchId` back on them. Cap is on unique events
         * post-dedup; natural dedup usually keeps us under it.
         * @param {number} maxUniqueEvents
         * @returns {Promise<BatchRecord | null>}
         */
        async claimUnclaimed(maxUniqueEvents) {
            return db.write(
                ['verificationResults', 'telemetryBatches'],
                async ({ verificationResults, telemetryBatches }) => {
                    const allVerdicts = await verificationResults.getAll();
                    const unclaimedVerdicts = allVerdicts
                        .filter((v) => !v.batchId)
                        .sort((a, b) => {
                            const aV = VIOLATION_STATUSES.has(a.status) ? 0 : 1;
                            const bV = VIOLATION_STATUSES.has(b.status) ? 0 : 1;
                            if (aV !== bV) {
                                return aV - bV;
                            }
                            return a.timestamp - b.timestamp;
                        });
                    if (unclaimedVerdicts.length === 0) {
                        logger.log('telemetryBatchesStore.claimUnclaimed: no unclaimed verdicts');
                        return null;
                    }

                    const uniqueEvents = new Map();
                    const claimedVerdicts = [];
                    for (const verdict of unclaimedVerdicts) {
                        const key = await eventKey(verdict);
                        const existing = uniqueEvents.get(key);
                        if (existing) {
                            existing.occurrenceCount += 1;
                            claimedVerdicts.push(verdict);
                        } else if (uniqueEvents.size < maxUniqueEvents) {
                            uniqueEvents.set(key, { ...verdict, key, occurrenceCount: 1 });
                            claimedVerdicts.push(verdict);
                        }
                    }

                    const batch = {
                        id: crypto.randomUUID(),
                        createdAt: Date.now(),
                        events: Array.from(uniqueEvents.values()),
                        priority: claimedVerdicts.some((v) => VIOLATION_STATUSES.has(v.status)),
                    };
                    await telemetryBatches.add(batch);
                    for (const verdict of claimedVerdicts) {
                        verdict.batchId = batch.id;
                        await verificationResults.put(verdict);
                    }
                    logger.log(
                        `telemetryBatchesStore.claimUnclaimed: assembled batch ${batch.id} from ${claimedVerdicts.length} verdicts into ${uniqueEvents.size} events (priority=${batch.priority})`
                    );
                    return batch;
                }
            );
        },

        /**
         * Flip all `ids` to sent in one tx. Array signature is required —
         * a merged POST must flip every contributing batch atomically.
         * @param {string[]} ids
         */
        async markSent(ids) {
            if (ids.length === 0) {
                logger.log('telemetryBatchesStore.markSent: empty id list; skipping');
                return;
            }
            await db.write(['telemetryBatches'], async ({ telemetryBatches }) => {
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
