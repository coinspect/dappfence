import { SYNC_TAG_REPORT_EVENTS, VERIFICATION_STATUS } from '../core/constants.js';
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
 * Owns the orchestration of what happens with a verification verdict:
 *   - persists the event (securityEventsStore)
 *   - registers the active block when the verdict is a violation (activeBlocksStore)
 *   - returns mustBlock for the caller
 *
 * Call sites pass every verdict unconditionally; this service decides what to
 * do with it. MATCH/SKIPPED short-circuit as no-ops; non-violation telemetry
 * statuses (REWRITE / CSP_PROTECTED) are logged to the events store but never
 * activate a block; violations go all the way through.
 *
 * Status/assetType invariant held by the callers: MANIFEST and SERVICE_WORKER
 * asset types only reach the processor with MATCH / SKIPPED / isViolation
 * statuses — never REWRITE / CSP_PROTECTED / REDIRECT. The telemetry branch
 * below is therefore only ever hit for ASSET-type verdicts in practice.
 *
 * Static typing on `SecurityEventDetails` is enforced; callers that type-check
 * cannot pass malformed payloads, so no runtime devAsserts.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.manifestService
 */
export function createSecurityProcessor({ swContext, appStore, manifestService }) {
    const { securityEventsStore, activeBlocksStore, verificationResultsStore, sessionIdStore } =
        appStore;
    const userAgent = swContext.getUserAgent();
    const origin = swContext.getLocationOrigin();

    // Shared in-memory buffer drained by reportAfterFetch / reportAfterInstall.
    // SW is single-threaded; multiple drains are idempotent (second finds empty).
    const pending = { events: [] };

    /**
     * @param {SecurityEventDetails} details
     * @returns {Promise<boolean>} mustBlock
     */
    async function processSecurityEvent(details) {
        pending.events.push(details);
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
            const mustBlock = await activeBlocksStore.recordSecurityBlock({
                status: statusName,
                reason: details.reason,
                fileKey: details.fileKey,
                url: details.url,
                assetType: details.assetType,
                expectedHashes: details.expectedHashes,
                actualHash: details.actualHash,
                httpStatus: details.httpStatus,
            });
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

    async function flushPendingEvents() {
        // Atomic snapshot, splice is synchronous.
        for (const details of pending.events.splice(0)) {
            if (details.status === VERIFICATION_STATUS.SKIPPED) {
                continue;
            }
            try {
                const record = {
                    ...details,
                    status: details.status.description,
                    appVersion: details.manifestInfo?.appVersion,
                    userAgent,
                    origin,
                };
                if (details.status === VERIFICATION_STATUS.MATCH) {
                    await verificationResultsStore.add(record.appVersion, record);
                } else {
                    await securityEventsStore.logSecurityEvent(record);
                }
            } catch (error) {
                logger.error('Failed to persist event:', error);
            }
        }
    }

    async function sendPendingReports() {
        const { telemetryUrl, appVersion } = await manifestService.resolveManifest();
        if (!telemetryUrl) {
            logger.log('sendPendingReports: no telemetryUrl resolved, skipping');
            return true;
        }
        const pendingBlocks = await activeBlocksStore.getPendingReportBlocks();
        if (pendingBlocks.length === 0) {
            logger.log('sendPendingReports: no pending blocks, skipping');
            return true;
        }
        const sessionId = await sessionIdStore.getSessionId();
        const envelope = {
            sessionId,
            appVersion,
            origin,
            userAgent,
            sentAt: new Date().toISOString(),
            events: pendingBlocks,
        };
        const ok = await sendBatch(telemetryUrl, envelope);
        if (!ok) {
            logger.error('sendPendingReports: POST failed, scheduling sync retry');
            try {
                await swContext.registerSync(SYNC_TAG_REPORT_EVENTS);
            } catch (regErr) {
                logger.warn('sync.register failed; next fetch/ping drives retry:', regErr);
            }
            return false;
        }
        await activeBlocksStore.markReported(
            pendingBlocks.map((b) => b.id),
            envelope.sentAt
        );
        logger.log(`sendPendingReports: posted ${pendingBlocks.length} blocks`);
        return true;
    }

    async function sendBatch(endpoint, body) {
        try {
            const response = await swContext.fetch(endpoint, {
                method: 'POST',
                keepalive: true,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response?.ok) {
                logger.error(`Telemetry POST failed with status=${response?.status ?? 0}`);
                return false;
            }
            return true;
        } catch (error) {
            logger.error('Telemetry POST threw:', error);
            return false;
        }
    }

    async function reportAfterFetch(event) {
        const clientId =
            event.request.mode === 'navigate' ? event.resultingClientId : event.clientId;
        logger.log(`reportAfterFetch clientId=${clientId}`);
        await safely(flushPendingEvents, (e) => logger.error('flushPendingEvents failed:', e));
        await safely(sendPendingReports, (e) => logger.error('sendPendingReports failed:', e));
    }

    async function reportAfterInstall(/** @type {ExtendableEvent} */ _event) {
        logger.log('reportAfterInstall');
        await safely(flushPendingEvents, (e) => logger.error('flushPendingEvents failed:', e));
        await safely(sendPendingReports, (e) => logger.error('sendPendingReports failed:', e));
    }

    async function reportOnClientRequest(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(`reportOnClientRequest clientId=${event?.source?.id}`);
        await safely(flushPendingEvents, (e) => logger.error('flushPendingEvents failed:', e));
        await safely(sendPendingReports, (e) => logger.error('sendPendingReports failed:', e));
    }

    async function reportOnPageLoad(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(
            `reportOnPageLoad clientId=${event?.source?.id} pageUrl=${event?.data?.pageUrl}`
        );
    }

    async function reportOnSync(/** @type {SyncEvent} */ event) {
        logger.log(`reportOnSync lastChance=${event?.lastChance}`);
        await safely(flushPendingEvents, (e) => logger.error('flushPendingEvents failed:', e));
        const sent = await sendPendingReports();
        if (!sent) {
            throw new Error(
                'sync drain POST failed rejecting waitUntil so Chromium schedules backoff + lastChance'
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
