import { SYNC_TAG_REPORT_EVENTS } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const MAX_UNIQUE_EVENTS = 50;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 500;
const CEILING_MS = 3000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const POST_TIMEOUT_MS = 10_000;

/**
 * Telemetry executor — batch send cycle for verification events, hidden behind
 * the security-processor facade. Logs will land as its own factory.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.manifestService
 * @param {object} deps.taskManager
 */
export function createTelemetryExecutor({ swContext, appStore, manifestService, taskManager }) {
    const { telemetryBatchesStore, settingsStore } = appStore;

    let cyclePromise = null;
    let eventFired = false;

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

    /**
     * Priority+oldest-first greedy merge, capped at MAX_UNIQUE_EVENTS post-dedup.
     * Stops at the first batch that would overflow — no leap-frog. Only the
     * returned pickedIds should be marked sent.
     */
    function mergeBatches(pendingBatches) {
        const sorted = pendingBatches.slice().sort((a, b) => {
            if (a.priority !== b.priority) {
                return a.priority ? -1 : 1;
            }
            return a.createdAt - b.createdAt;
        });

        const merged = new Map();
        const pickedIds = [];
        for (const batch of sorted) {
            let newKeys = 0;
            for (const event of batch.events) {
                if (!merged.has(event.key)) {
                    newKeys += 1;
                }
            }
            if (merged.size + newKeys > MAX_UNIQUE_EVENTS) {
                break;
            }
            for (const event of batch.events) {
                const existing = merged.get(event.key);
                if (existing) {
                    existing.occurrenceCount += event.occurrenceCount;
                } else {
                    merged.set(event.key, { ...event });
                }
            }
            pickedIds.push(batch.id);
        }
        return { events: Array.from(merged.values()), pickedIds };
    }

    async function sendEvents(pendingBatches, endpoint, appVersion) {
        const { events, pickedIds } = mergeBatches(pendingBatches);
        if (pickedIds.length === 0) {
            logger.log('sendEvents: no batches fit under MAX_UNIQUE_EVENTS; skipping cycle');
            return false;
        }

        const envelope = {
            appVersion: appVersion ?? null,
            installationTime: await settingsStore.getInstallationTime(),
            origin: swContext.getLocationOrigin(),
            userAgent: swContext.getUserAgent(),
            sentAt: new Date().toISOString(),
            events,
        };
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

    async function runCycle(endpoint, appVersion) {
        return taskManager.run(async () => {
            eventFired = false;
            await telemetryBatchesStore.purge(Date.now() - SENT_RETENTION_MS);
            let pendingBatches = await telemetryBatchesStore.getPending();
            while (true) {
                // Collection window: a burst of fetches during a page load
                // piles into one batch instead of shipping on the first event.
                await new Promise((r) => setTimeout(r, TICK_MS));
                const newBatch = await telemetryBatchesStore.claimUnclaimed(MAX_UNIQUE_EVENTS);
                if (newBatch) {
                    pendingBatches.push(newBatch);
                }
                const now = Date.now();
                const sendNow =
                    pendingBatches.length > 0 &&
                    pendingBatches.some((b) => b.priority || now - b.createdAt >= CEILING_MS);
                if (sendNow) {
                    const sent = await sendEvents(pendingBatches, endpoint, appVersion);
                    if (!sent) {
                        // Failed: exponential backoff + jitter
                        return false;
                    }
                    pendingBatches = await telemetryBatchesStore.getPending();
                    eventFired = false;
                    continue;
                }
                if (pendingBatches.length > 0) {
                    continue;
                }
                // pendingBatches empty: exit unless a late onEvent raced in
                if (eventFired) {
                    eventFired = false;
                    continue;
                }
                logger.log('runCycle: nothing waiting; cycle idle');
                return true;
            }
        });
    }

    async function onEvent() {
        const { appVersion, telemetryEndpoints } = await manifestService.resolveManifest();
        const endpoint = telemetryEndpoints?.events;
        if (!endpoint) {
            logger.log('onEvent: events endpoint not configured; skipping');
            return true;
        }
        const state = await telemetryBatchesStore.getRetryState();
        if (Date.now() < state.nextAttemptAt) {
            logger.log(`onEvent: backoff active, +${state.nextAttemptAt - Date.now()}ms to go`);
            return true;
        }
        eventFired = true;
        if (!cyclePromise) {
            cyclePromise = runCycle(endpoint, appVersion).finally(() => {
                cyclePromise = null;
            });
        }
        return cyclePromise;
    }

    return { onEvent };
}
