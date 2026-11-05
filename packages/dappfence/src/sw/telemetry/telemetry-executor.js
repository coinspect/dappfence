import { SYNC_TAG_REPORT_EVENTS, VERIFICATION_STATUS_BY_NAME } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

/** @typedef {import('../storage/verification-results-store.js').VerdictRow} VerdictRow */

const logger = createLogger();

// Fetch spec: in-flight keepalive request bodies capped at 64 KiB.
const KEEPALIVE_QUOTA_BYTES = 64 * 1024;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 500;
const CEILING_MS = 3000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const POST_TIMEOUT_MS = 10_000;

// Wire-visible only — internal verdict fields must not change dedup identity.
const IDENTITY_FIELDS = [
    'assetType',
    'status',
    'reason',
    'fileKey',
    'expectedHashes',
    'actualHash',
];

/**
 * Telemetry executor — batches verification events and ships them to the
 * manifest-declared endpoint. Exposes two methods to the security-processor
 * facade: `scheduleTelemetrySend()` (fire-and-forget trigger that ensures a
 * send loop is running) and `hasPendingTelemetry()` (awaits any in-flight send
 * and reports whether retry is still needed — used by the sync handler to
 * decide whether to throw).
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.manifestService
 * @param {object} deps.taskManager
 */
export function createTelemetryExecutor({ swContext, appStore, manifestService, taskManager }) {
    const { telemetryBatchesStore, verificationResultsStore, settingsStore } = appStore;

    let scheduleRequest = false;
    let pendingTelemetryPromise = null;
    let cachedMaxEventsBytes = null;

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
        if (cachedMaxEventsBytes === null) {
            const installationTime = await settingsStore.getInstallationTime();
            const envelope = renderEnvelope({
                appVersion: 'manifest-0123456789abcdef', // exact 25-char format
                installationTime, // real runtime value, stable per install
                origin: swContext.getLocationOrigin(), // real deployment value
                userAgent: swContext.getUserAgent(), // real browser session value
                sentAt: '0000-00-00T00:00:00.000Z', // exact 24-char ISO format
                events: [],
            });
            cachedMaxEventsBytes = KEEPALIVE_QUOTA_BYTES - JSON.stringify(envelope).length;
        }
        return cachedMaxEventsBytes;
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
            if (!merged.addMany(eventsByBatchId.get(batch.id) ?? [], maxEventsBytes)) {
                break;
            }
            pickedIds.push(batch.id);
        }
        return { events: merged.events, pickedIds };
    }

    async function post(endpoint, envelope) {
        try {
            const response = await swContext.fetch(endpoint, {
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

    async function sendEvents(pendingBatches, endpoint, appVersion, maxEventsBytes) {
        const eventsByBatchId = await verificationResultsStore.getByBatchId();
        const { events, pickedIds } = mergeBatches(pendingBatches, eventsByBatchId, maxEventsBytes);
        if (pickedIds.length === 0) {
            logger.log('sendEvents: no batches fit under caps; skipping cycle');
            return false;
        }

        const envelope = renderEnvelope({
            appVersion,
            installationTime: await settingsStore.getInstallationTime(),
            origin: swContext.getLocationOrigin(),
            userAgent: swContext.getUserAgent(),
            sentAt: new Date().toISOString(),
            events,
        });
        const sent = await post(endpoint, envelope);
        if (sent) {
            await telemetryBatchesStore.markSent(pickedIds);
            return true;
        }

        const next = await telemetryBatchesStore.bumpRetryState({
            baseMs: BACKOFF_BASE_MS,
            capMs: BACKOFF_CAP_MS,
        });
        logger.log(
            `sendEvents: POST failed, attempt=${next.attemptNumber}, next retry at ${new Date(next.nextAttemptAt).toISOString()}`
        );
        try {
            await swContext.registerSync(SYNC_TAG_REPORT_EVENTS);
        } catch (regErr) {
            logger.warn('sync.register failed; next fetch/ping drives retry:', regErr);
        }
        return false;
    }

    async function sendLoop() {
        try {
            const { appVersion, telemetryEndpoints } = await manifestService.resolveManifest();
            const endpoint = telemetryEndpoints?.events;
            if (!endpoint) {
                logger.log('sendLoop: no events endpoint; exiting');
                return false;
            }
            const state = await telemetryBatchesStore.getRetryState();
            if (Date.now() < state.nextAttemptAt) {
                logger.log(
                    `sendLoop: backoff active, +${state.nextAttemptAt - Date.now()}ms to go`
                );
                return false;
            }
            const maxEventsBytes = await getMaxEventsBytes();
            const selectVerdicts = makeSelectVerdicts(maxEventsBytes);
            scheduleRequest = false;
            await telemetryBatchesStore.purge(Date.now() - SENT_RETENTION_MS);
            let pendingBatches = await telemetryBatchesStore.getPending();
            while (true) {
                // Collection window: a burst of fetches during a page load
                // piles into one batch instead of shipping on the first event.
                await new Promise((r) => setTimeout(r, TICK_MS));
                const newBatch = await telemetryBatchesStore.createBatch(selectVerdicts);
                if (newBatch) {
                    pendingBatches.push(newBatch);
                }
                const now = Date.now();
                const sendNow =
                    pendingBatches.length > 0 &&
                    pendingBatches.some((b) => b.priority || now - b.createdAt >= CEILING_MS);
                if (sendNow) {
                    const sent = await sendEvents(
                        pendingBatches,
                        endpoint,
                        appVersion,
                        maxEventsBytes
                    );
                    if (!sent) {
                        // Failed: exponential backoff + jitter
                        return true;
                    }
                    pendingBatches = await telemetryBatchesStore.getPending();
                    scheduleRequest = false;
                    continue;
                }
                if (pendingBatches.length > 0) {
                    continue;
                }
                // pendingBatches empty: exit unless a late scheduleTelemetrySend raced in
                if (scheduleRequest) {
                    scheduleRequest = false;
                    continue;
                }
                logger.log('sendLoop: nothing waiting; nothing to send');
                return false;
            }
        } catch (err) {
            logger.error('sendLoop threw:', err);
            return true; // treat as pending → sync throws, non-sync ignores
        }
    }

    function scheduleTelemetrySend() {
        scheduleRequest = true;
        if (!pendingTelemetryPromise) {
            pendingTelemetryPromise = taskManager.run(() =>
                sendLoop().finally(() => {
                    pendingTelemetryPromise = null;
                })
            );
        }
    }

    async function hasPendingTelemetry() {
        if (!pendingTelemetryPromise) {
            return false;
        }
        return pendingTelemetryPromise;
    }

    return { scheduleTelemetrySend, hasPendingTelemetry };
}
