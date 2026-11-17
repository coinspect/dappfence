import { createStreamDriver } from './stream-driver.js';
import { VERIFICATION_STATUS_BY_NAME } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

/** @typedef {import('./stream-driver.js').TryToSendResult} TryToSendResult */
/** @typedef {import('../storage/verification-results-store.js').VerdictRow} VerdictRow */

const logger = createLogger();

/**
 * Events telemetry stream — collects verification verdicts into batches,
 * ships them to `manifest.telemetryEndpoints.events`, and persists the
 * batch-sent + backoff state in a single atomic tx.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.manifestService
 * @param {object} deps.taskManager
 */
export function createEventStream({ swContext, appStore, manifestService, taskManager }) {
    const POST_TIMEOUT_MS = 10_000;
    // Fetch spec: in-flight keepalive request bodies capped at 64 KiB.
    const KEEPALIVE_QUOTA_BYTES = 64 * 1024;
    const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const CEILING_MS = 3000;
    // Wire-visible only — internal verdict fields must not change dedup identity.
    const IDENTITY_FIELDS = [
        'assetType',
        'status',
        'reason',
        'fileKey',
        'expectedHashes',
        'actualHash',
    ];

    const { telemetryBatchesStore, verificationResultsStore, settingsStore } = appStore;
    const name = 'events';
    let maxEventsBytes;
    let selectVerdicts;
    let pendingBatches;
    let currentManifest;

    function renderEnvelope({ appVersion, installationTime, origin, userAgent, sentAt, events }) {
        return {
            appVersion: appVersion ?? null,
            installationTime,
            origin,
            userAgent,
            sentAt,
            events,
        };
    }

    /**
     * @param {VerdictRow} verdict
     * @param {number} occurrenceCount
     */
    function renderEvent(verdict, occurrenceCount) {
        return {
            id: verdict.id,
            appVersion: verdict.appVersion,
            timestamp: verdict.timestamp,
            status: verdict.status,
            fileKey: verdict.fileKey,
            reason: verdict.reason,
            expectedHashes: verdict.expectedHashes,
            actualHash: verdict.actualHash,
            url: verdict.url,
            destination: verdict.destination,
            httpStatus: verdict.httpStatus,
            clientId: verdict.clientId,
            assetType: verdict.assetType,
            occurrenceCount,
        };
    }

    async function post(events) {
        try {
            const envelope = renderEnvelope({
                appVersion: currentManifest.appVersion,
                installationTime: await settingsStore.getInstallationTime(),
                origin: swContext.getLocationOrigin(),
                userAgent: swContext.getUserAgent(),
                sentAt: new Date().toISOString(),
                events,
            });
            const response = await swContext.fetch(currentManifest.telemetryEndpoints?.events, {
                method: 'POST',
                keepalive: true,
                mode: 'cors',
                credentials: 'omit',
                priority: 'low',
                referrerPolicy: 'no-referrer',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(envelope),
                signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            });
            if (!response?.ok) {
                logger.error(`telemetry POST failed status=${response?.status ?? 0}`);
                return false;
            }
            return true;
        } catch (err) {
            logger.error('telemetry POST threw:', err);
            return false;
        }
    }

    /**
     * Dedup-aware event accumulator. Owns a Map and its serialized byte
     * footprint together so they can't drift. `tryAdd` is atomic: all events
     * fit (true, state mutated) or none do (false, state unchanged).
     */
    function makeDedupMap() {
        const map = new Map();
        let bytes = 0;

        function addOne(verdict, maxEventsBytes) {
            const dedupKey = JSON.stringify(IDENTITY_FIELDS.map((f) => verdict[f] ?? null));
            const existing = map.get(dedupKey);
            if (existing) {
                const delta =
                    String(existing.occurrenceCount + 1).length -
                    String(existing.occurrenceCount).length;
                if (bytes + delta > maxEventsBytes) {
                    return false;
                }
                existing.occurrenceCount += 1;
                bytes += delta;
                return true;
            }
            const event = renderEvent(verdict, 1);
            const delta = JSON.stringify(event).length + (map.size === 0 ? 2 : 1);
            if (bytes + delta > maxEventsBytes) {
                return false;
            }
            map.set(dedupKey, event);
            bytes += delta;
            return true;
        }

        return {
            get size() {
                return bytes;
            },
            get events() {
                return Array.from(map.values());
            },
            addOne,
            addMany(events, maxEventsBytes) {
                const snapshotMap = new Map();
                for (const [k, v] of map) {
                    snapshotMap.set(k, { ...v });
                }
                const snapshotBytes = bytes;
                for (const event of events) {
                    if (!addOne(event, maxEventsBytes)) {
                        map.clear();
                        for (const [k, v] of snapshotMap) {
                            map.set(k, v);
                        }
                        bytes = snapshotBytes;
                        return false;
                    }
                }
                return true;
            },
        };
    }

    /**
     * One-time compute of the events-array byte cap, derived from the real
     * envelope shape with real deployment values. Cached because origin,
     * userAgent, and installationTime are stable for the SW lifetime.
     */
    async function getMaxEventsBytes() {
        const installationTime = await settingsStore.getInstallationTime();
        const envelope = renderEnvelope({
            appVersion: 'manifest-0123456789abcdef', // exact 25-char format
            installationTime, // real runtime value, stable per install
            origin: swContext.getLocationOrigin(), // real deployment value
            userAgent: swContext.getUserAgent(), // real browser session value
            sentAt: '0000-00-00T00:00:00.000Z', // exact 24-char ISO format
            events: [],
        });
        return KEEPALIVE_QUOTA_BYTES - JSON.stringify(envelope).length;
    }

    /**
     * createBatch factory: picks verdicts (violations first, oldest first)
     * with virtual dedup, stopping when the serialized events array would
     * exceed `maxEventsBytes`.
     * @param {number} maxEventsBytes
     * @returns {(unclaimed: VerdictRow[]) => VerdictRow[]}
     */
    function makeSelectVerdicts(maxEventsBytes) {
        return (unclaimed) => {
            unclaimed.sort((a, b) => {
                const aV = VERIFICATION_STATUS_BY_NAME.get(a.status)?.isViolation ? 0 : 1;
                const bV = VERIFICATION_STATUS_BY_NAME.get(b.status)?.isViolation ? 0 : 1;
                if (aV !== bV) {
                    return aV - bV;
                }
                return a.timestamp - b.timestamp;
            });
            const dedupMap = makeDedupMap();
            const claimed = [];
            for (const verdict of unclaimed) {
                if (!dedupMap.addOne(verdict, maxEventsBytes)) {
                    break;
                }
                claimed.push(verdict);
            }
            return claimed;
        };
    }

    /**
     * Greedy-merge pending batches in priority + oldest-first order, capped by
     * `maxEventsBytes`. All-or-nothing per batch — any batch that would overflow stops
     * the loop. Only returned pickedIds are marked sent.
     * @param {Array<{id: string, priority: boolean, createdAt: number}>} pendingBatches
     * @param {Map<string, VerdictRow[]>} eventsByBatchId
     * @param {number} maxEventsBytes
     */
    function mergeBatches(pendingBatches, eventsByBatchId, maxEventsBytes) {
        pendingBatches.sort((a, b) => {
            if (a.priority !== b.priority) {
                return a.priority ? -1 : 1;
            }
            return a.createdAt - b.createdAt;
        });
        const merged = makeDedupMap();
        const pickedIds = [];
        for (const batch of pendingBatches) {
            const events = eventsByBatchId.get(batch.id) ?? [];
            if (!merged.addMany(events, maxEventsBytes)) {
                break;
            }
            if (events.length > 0) {
                pickedIds.push(batch.id);
            }
        }

        return { events: merged.events, pickedIds };
    }

    async function canRun() {
        try {
            currentManifest = await manifestService.resolveManifest();
        } catch (err) {
            logger.error(`[${name}] resolveManifest threw:`, err);
            return false;
        }
        return !!currentManifest.telemetryEndpoints?.events;
    }

    async function init() {
        if (!maxEventsBytes) {
            maxEventsBytes = await getMaxEventsBytes();
            selectVerdicts = makeSelectVerdicts(maxEventsBytes);
        }
        await telemetryBatchesStore.purge(Date.now() - SENT_RETENTION_MS);
        pendingBatches = await telemetryBatchesStore.getPending();
    }

    /**
     * @param {(ok: boolean, markInTx?: (helpers: any) => Promise<void>) => Promise<any>} commitWhenDone
     * @returns {Promise<TryToSendResult>}
     */
    async function tryToSend(commitWhenDone) {
        const newBatch = await telemetryBatchesStore.createBatch(selectVerdicts);
        if (newBatch) {
            pendingBatches.push(newBatch);
        }

        const now = Date.now();
        const shouldSend =
            pendingBatches.length > 0 &&
            pendingBatches.some((b) => b.priority || now - b.createdAt >= CEILING_MS);
        if (!shouldSend) {
            return pendingBatches.length > 0 ? 'postponed' : 'done';
        }

        const eventsByBatchId = await verificationResultsStore.getByBatchId();
        const { events, pickedIds } = mergeBatches(pendingBatches, eventsByBatchId, maxEventsBytes);
        if (pickedIds.length === 0) {
            logger.log(`[${name}] nothing to ship after dedup; exiting cycle`);
            return 'done';
        }

        const ok = await post(events);

        await commitWhenDone(ok, async (helpers) => {
            for (const id of pickedIds) {
                const batch = await helpers.telemetryBatches.get(id);
                if (!batch) {
                    logger.log(`[${name}] markSent: no batch for id ${id}; skipping`);
                    continue;
                }
                batch.sentAt = now;
                await helpers.telemetryBatches.put(batch);
            }
        });

        if (ok) {
            pendingBatches = await telemetryBatchesStore.getPending();
        }
        return ok ? 'sent' : 'send-failed';
    }

    return createStreamDriver({
        name,
        swContext,
        taskManager,
        telemetryBatchesStore,
        canRun,
        init,
        tryToSend,
    });
}
