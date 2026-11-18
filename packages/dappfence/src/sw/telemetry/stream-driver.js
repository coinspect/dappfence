/**
 * Stream driver — tick-loop primitive shared by every telemetry stream.
 *
 * Owns the parts that are the same everywhere: coalescing of concurrent
 * `scheduleSend` calls, the sync vs regular trigger plumbing, backoff gate
 * check, keepalive handshake via `taskManager`, and the collection-window
 * tick loop.
 *
 * The spec implements the per-stream side: `canRun()` (resolve + stash the
 * manifest + decide whether the stream is active), `init()` (any per-cycle
 * setup), and `tryToSend(commitWhenDone)` (one iteration of the state
 * machine, returns 'sent' | 'send-failed' | 'postponed' | 'done'). The spec
 * invokes `commitWhenDone(ok, markInTx?)` (a closure the driver hands in)
 * to atomically persist mark-sent work + advance backoff. Backoff cache
 * lives in the storage layer — the driver reads via `getRetryStateForStream`.
 */

import { SYNC_TAG_TELEMETRY } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const TICK_MS = 500;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

const RETRY_DEFAULT = Object.freeze({ attemptNumber: 0, nextAttemptAt: 0 });

/**
 * @typedef {{ attemptNumber: number, nextAttemptAt: number }} RetryState
 *
 * @typedef {'sent' | 'send-failed' | 'postponed' | 'done'} TryToSendResult
 *
 * @typedef {{
 *   name: string,
 *   swContext: { registerSync: (tag: string) => Promise<void> },
 *   taskManager: { run: (fn: () => any) => Promise<any> },
 *   telemetryBatchesStore: {
 *     getRetryStateForStream: (stream: string) => Promise<RetryState | undefined>,
 *     withRetryTxForStream: (stream: string, fn: (helpers: any) => Promise<any>) => Promise<any>,
 *   },
 *   canRun: () => Promise<boolean>,
 *   init: () => Promise<void>,
 *   tryToSend: (commitWhenDone: (ok: boolean, markInTx?: (helpers: any) => Promise<void>) => Promise<void>) => Promise<TryToSendResult>,
 * }} StreamDriverSpec
 */

const RETRY = true;
const DONE = false;

/**
 * @param {StreamDriverSpec} spec
 */
export function createStreamDriver(spec) {
    const { name, swContext, taskManager, telemetryBatchesStore, canRun, init, tryToSend } = spec;

    let sendScheduled = false;
    let pendingSendPromise = null;

    async function commitWhenDone(ok, markInTx) {
        return telemetryBatchesStore.withRetryTxForStream(name, async (helpers) => {
            if (ok) {
                if (markInTx) {
                    await markInTx(helpers);
                }
                await helpers.retry.put(RETRY_DEFAULT);
                return RETRY_DEFAULT;
            }

            const prev = (await helpers.retry.get()) ?? RETRY_DEFAULT;
            const attemptNumber = prev.attemptNumber + 1;
            const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attemptNumber - 1));
            const jitter = Math.random() * base * 0.5;
            const next = {
                attemptNumber,
                nextAttemptAt: Date.now() + base + jitter,
            };

            await helpers.retry.put(next);
            return next;
        });
    }

    async function sendLoop(isSyncAttempt) {
        if (!(await logger.withDebugLog(() => canRun()))) {
            logger.debug(`[${name}] sendLoop: canRun=false; exiting`);
            return DONE;
        }

        if (!isSyncAttempt) {
            const state =
                (await logger.withDebugLog(() =>
                    telemetryBatchesStore.getRetryStateForStream(name)
                )) ?? RETRY_DEFAULT;
            const delta = state.nextAttemptAt - Date.now();
            if (delta > 0) {
                logger.debug(`[${name}] sendLoop: backoff active, +${delta}ms to go`);
                return DONE;
            }
        }

        try {
            await logger.withDebugLog(() => swContext.registerSync(SYNC_TAG_TELEMETRY));
        } catch (err) {
            logger.warn(`[${name}] sync.register failed:`, err);
        }

        sendScheduled = false;
        try {
            await logger.withDebugLog(() => init());
        } catch (err) {
            logger.error(`[${name}] init threw:`, err);
            return DONE;
        }

        try {
            while (true) {
                await new Promise((r) => setTimeout(r, TICK_MS));

                const result = await logger.withDebugLog(() => tryToSend(commitWhenDone));
                switch (result) {
                    case 'sent':
                        sendScheduled = false;
                        continue;
                    case 'send-failed':
                        return RETRY;
                    case 'postponed':
                        continue;
                    case 'done':
                        if (sendScheduled) {
                            sendScheduled = false;
                            continue;
                        }
                        logger.debug(`[${name}] sendLoop: nothing waiting; nothing to send`);
                        return DONE;
                    default: {
                        logger.error(`[${name}] unknown tryToSend result: ${result}`);
                        return RETRY;
                    }
                }
            }
        } catch (err) {
            logger.error(`[${name}] send tick threw:`, err);
            return RETRY;
        }
    }

    function scheduleTelemetrySend(isSyncAttempt) {
        sendScheduled = true;
        if (!pendingSendPromise) {
            pendingSendPromise = taskManager.run(() =>
                sendLoop(isSyncAttempt)
                    .then((stillPending) => ({ stillPending, wasSyncAttempt: isSyncAttempt }))
                    .finally(() => {
                        pendingSendPromise = null;
                    })
            );
        }
        return pendingSendPromise;
    }

    function scheduleSend() {
        scheduleTelemetrySend(false);
    }

    async function scheduleSyncSend() {
        if (pendingSendPromise) {
            const outcome = await pendingSendPromise;
            if (outcome.wasSyncAttempt) {
                return outcome.stillPending;
            }
        }
        const outcome = await scheduleTelemetrySend(true);
        return outcome.stillPending;
    }

    return { name, scheduleSend, scheduleSyncSend };
}
