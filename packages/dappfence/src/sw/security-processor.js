import { VERIFICATION_STATUS } from '../core/constants.js';
import { createLogger } from '../core/logger.js';
import { safely } from '../core/utils.js';

const logger = createLogger();

/** @typedef {import('../core/constants.js').AssetType} AssetType */
/** @typedef {import('../core/constants.js').VerificationStatus} VerificationStatus */
/** @typedef {import('../core/constants.js').AssetErrorReason} AssetErrorReason */
/** @typedef {import('../core/constants.js').FileUntrustedReason} FileUntrustedReason */
/** @typedef {import('../core/constants.js').ManifestLoadReason} ManifestLoadReason */

/**
 * @typedef {{ appVersion: string, manifest: object, storedAt?: number }} ManifestInfo
 */

/**
 * @typedef {{
 *   status: VerificationStatus,
 *   assetType: AssetType,
 *   fileKey: string,
 *   url: string,
 *   manifestInfo?: ManifestInfo,
 *   clientId?: string,
 *   destination?: string,
 *   requestMode?: string,
 *   method?: string,
 *   reason?: AssetErrorReason | FileUntrustedReason | ManifestLoadReason,
 *   actualHash?: string,
 *   expectedHashes?: string[],
 *   httpStatus?: number,
 * }} SecurityEventDetails
 */

/**
 * @typedef {(d: { fileKey?: string, url?: string, reason?: string, expectedHashes?: string[], actualHash?: string }) => string[]} StatusLogFormatter
 */

/** @type {Record<keyof typeof VERIFICATION_STATUS, StatusLogFormatter>} */
const STATUS_LOG = {
    MATCH: (d) => [`SW file verification passed: ${d.fileKey}`],
    SKIPPED: (d) => [`SW file verification skipped: ${d.fileKey}`],
    REWRITE: (d) => [`SW file response rewritten: ${d.fileKey}`],
    REDIRECT: (d) => [`SW file redirect materialized: ${d.fileKey}`],
    CSP_PROTECTED: (d) => [`SW file CSP-protected (verify skipped): ${d.fileKey}`],
    FILE_UNTRUSTED: (d) => [
        `SECURITY ALERT: File is not trusted (${d.reason ?? 'UNSPECIFIED'})!`,
        `File: ${d.fileKey ?? d.url}`,
        ...(d.expectedHashes ? [`Expected: ${d.expectedHashes.join(', ')}`] : []),
        ...(d.actualHash ? [`Actual: ${d.actualHash}`] : []),
    ],
    DENIED_BY_RULE: (d) => [`SECURITY ALERT: File denied by security rule!`, `File: ${d.fileKey}`],
    ERROR: (d) => [
        `SECURITY ALERT: Verification error (${d.reason ?? 'UNSPECIFIED'})!`,
        `File: ${d.fileKey ?? 'N/A'}`,
    ],
    MANIFEST_UNTRUSTED: (d) => [
        `SECURITY ALERT: Manifest cannot be trusted (${d.reason ?? 'UNSPECIFIED'})!`,
        `File: ${d.fileKey ?? 'N/A'}`,
        ...(d.expectedHashes ? [`Expected: ${d.expectedHashes.join(', ')}`] : []),
        ...(d.actualHash ? [`Actual: ${d.actualHash}`] : []),
    ],
};

/**
 * Security Processor
 *
 * Facade over verdict ingestion + telemetry executor. Outside modules
 * (main, lifecycle, message-broker) talk only to this surface:
 *   - processSecurityEvent: logs, records violation, returns mustBlock
 *   - reportAfter* / reportOn*: flush pending + hop keepalive + schedule telemetry send
 *
 * The telemetry executor (batch send cycle, task-manager keepalive) is an
 * implementation detail injected by services.js and never exposed externally.
 *
 * @param {object} deps
 * @param {object} deps.appStore
 * @param {object} deps.telemetryExecutor
 * @param {object} deps.taskManager
 */
export function createSecurityProcessor({ appStore, telemetryExecutor, taskManager }) {
    const { securityStore, verificationResultsStore } = appStore;

    function createPendingBuffer() {
        let events = [];
        return {
            append(details) {
                events.push(details);
            },
            atomicSwap() {
                const taken = events;
                events = [];
                return taken;
            },
        };
    }

    const pending = createPendingBuffer();

    /**
     * @param {SecurityEventDetails} details
     * @returns {Promise<boolean>} mustBlock
     */
    async function processSecurityEvent(details) {
        pending.append(details);
        if (
            details.status === VERIFICATION_STATUS.MATCH ||
            details.status === VERIFICATION_STATUS.SKIPPED
        ) {
            return false;
        }
        const statusName = details.status.description;
        const method = details.status.isViolation ? 'error' : 'log';
        const logArgs =
            STATUS_LOG[statusName] ??
            ((d) => [
                `SECURITY ALERT: {${statusName}}`,
                `URL: ${d.url ?? 'N/A'}`,
                `File: ${d.fileKey ?? 'N/A'}`,
            ]);
        logger[method](...logArgs(details));
        if (!details.status.isViolation) {
            logger.log(`Security event logged (no block): ${statusName} - ${details.fileKey}`);
            return false;
        }
        try {
            // Block records stay awaited on the hot path — losing one across
            // SW restart is worse than paying the IDB cost on a rare violation.
            const mustBlock = await securityStore.recordSecurityViolation(details);
            if (mustBlock) {
                logger.log(`Security violation handled: ${statusName} - ${details.fileKey}`);
            } else {
                logger.log(
                    `%cSecurity violation recurrence (not re-activated): ${statusName} - ${details.fileKey}`,
                    'color:yellow'
                );
            }
            return mustBlock;
        } catch (error) {
            logger.error('Failed to handle security event:', error);
            return true;
        }
    }

    async function flushPending() {
        for (const details of pending.atomicSwap()) {
            if (details.status === VERIFICATION_STATUS.SKIPPED) {
                continue;
            }
            try {
                await verificationResultsStore.add(details);
            } catch (error) {
                logger.error('Failed to persist event:', error);
            }
        }
    }

    async function handleReport(/** @type {ExtendableEvent | null} */ event) {
        try {
            await flushPending();
            if (event) {
                taskManager.attach(event);
            }
            telemetryExecutor.scheduleSend();
        } catch (err) {
            logger.error('handleReport failed:', err);
        }
    }

    async function reportAfterFetch(/** @type {FetchEvent} */ event) {
        const clientId =
            event.request.mode === 'navigate' ? event.resultingClientId : event.clientId;
        logger.log(`reportAfterFetch clientId=${clientId}`);
        await handleReport(event);
    }

    async function reportAfterInstall(/** @type {ExtendableEvent} */ _event) {
        logger.log('reportAfterInstall');
        // Skip `attach`: would extend install.waitUntil and block the next register() at this scope.
        await handleReport(null);
    }

    async function reportOnClientRequest(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(`reportOnClientRequest clientId=${event?.source?.id}`);
        await handleReport(event);
    }

    async function reportOnPageLoad(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(
            `reportOnPageLoad clientId=${event?.source?.id} pageUrl=${event?.data?.pageUrl}`
        );
        await handleReport(event);
    }

    // Sync is the only report* that lets errors propagate — a thrown
    // waitUntil tells Chromium to schedule backoff + eventually lastChance.
    async function reportOnSync(/** @type {SyncEvent} */ event) {
        logger.log(`reportOnSync lastChance=${event?.lastChance}`);
        await safely(flushPending, (e) => logger.error('flushPending failed:', e));
        taskManager.attach(event, true);
        if (await telemetryExecutor.scheduleSyncSend()) {
            throw new Error(
                'sync drain: ship failed; rejecting waitUntil to schedule backoff + lastChance'
            );
        }
    }

    return {
        processSecurityEvent,
        reportAfterFetch,
        reportAfterInstall,
        reportOnClientRequest,
        reportOnPageLoad,
        reportOnSync,
    };
}
