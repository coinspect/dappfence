import { createStreamDriver } from './stream-driver.js';
import { createLogger } from '../../core/logger.js';

/** @typedef {import('./stream-driver.js').TryToSendResult} TryToSendResult */

const logger = createLogger();

/**
 * Logs telemetry stream — drains the logger's ring buffer, ships to
 * `manifest.telemetryEndpoints.logs`, and commits backoff. Unlike events,
 * logs have no durable per-row store: the buffer lives in `logger` memory
 * (bounded by `BUFFER_CAP`) and in a local `pendingLogs` buffer that holds
 * drained-but-unshipped logs across failed attempts.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.manifestService
 * @param {object} deps.taskManager
 */
export function createLogStream({ swContext, appStore, manifestService, taskManager }) {
    const POST_TIMEOUT_MS = 10_000;
    const MAX_PENDING_LOGS = 10_000;

    const { telemetryBatchesStore, settingsStore } = appStore;
    const name = 'logs';
    let currentManifest;
    let pendingLogs = [];
    let warnedOverCap = false;

    function renderEnvelope({ appVersion, installationTime, origin, userAgent, sentAt, logs }) {
        return {
            appVersion: appVersion ?? null,
            installationTime,
            origin,
            userAgent,
            sentAt,
            logs,
        };
    }

    async function post(logs) {
        try {
            const envelope = renderEnvelope({
                appVersion: currentManifest.appVersion,
                installationTime: await settingsStore.getInstallationTime(),
                origin: swContext.getLocationOrigin(),
                userAgent: swContext.getUserAgent(),
                sentAt: new Date().toISOString(),
                logs,
            });
            const response = await swContext.fetch(currentManifest.telemetryEndpoints?.logs, {
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
                logger.error(`[${name}] POST failed status=${response?.status ?? 0}`);
                return false;
            }
            return true;
        } catch (err) {
            logger.error(`[${name}] POST threw:`, err);
            return false;
        }
    }

    async function canRun() {
        try {
            currentManifest = await manifestService.resolveManifest();
        } catch (err) {
            logger.error(`[${name}] resolveManifest threw:`, err);
            return false;
        }
        return !!currentManifest.telemetryEndpoints?.logs;
    }

    async function init() {
        // No per-cycle setup: logs stream is stateless beyond `pendingLogs`.
    }

    /**
     * @param {(ok: boolean, markInTx?: (helpers: any) => Promise<void>) => Promise<any>} commitWhenDone
     * @returns {Promise<TryToSendResult>}
     */
    async function tryToSend(commitWhenDone) {
        const freshLogs = logger.getPendingLogs();
        if (freshLogs.length > 0) {
            pendingLogs = pendingLogs.concat(freshLogs);
        }

        if (pendingLogs.length > MAX_PENDING_LOGS) {
            const dropped = pendingLogs.length - MAX_PENDING_LOGS;
            pendingLogs = pendingLogs.slice(-MAX_PENDING_LOGS);
            if (!warnedOverCap) {
                logger.warn(`[${name}] dropped ${dropped} oldest logs over cap`);
                warnedOverCap = true;
            }
        }

        if (pendingLogs.length === 0) {
            return 'done';
        }

        const ok = await post(pendingLogs);

        await commitWhenDone(ok);

        if (ok) {
            pendingLogs = [];
            warnedOverCap = false;
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
