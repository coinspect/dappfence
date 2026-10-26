import { VERIFICATION_STATUS } from '../core/constants.js';
import { createLogger } from '../core/logger.js';

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
 * Owns the orchestration of what happens with a verification verdict:
 *   - persists MATCH records (verificationResultsStore)
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
 * @param {object} deps.appStore
 */
export function createSecurityProcessor({ appStore }) {
    const { activeBlocksStore, verificationResultsStore } = appStore;

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
            const mustBlock = await activeBlocksStore.recordSecurityBlock(details);
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
        // Atomic snapshot, splice is synchronous.
        for (const details of pending.events.splice(0)) {
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

    /**
     * Drains and persists queued security events asynchronously without blocking the fetch response.
     * Executed inside `event.waitUntil` after the fetch response promise settles.
     *
     * @param {FetchEvent} event
     */
    async function reportAfterFetch(event) {
        const clientId =
            event.request.mode === 'navigate' ? event.resultingClientId : event.clientId;
        logger.log(`reportAfterFetch clientId=${clientId}`);
        await flushPending();
    }

    async function reportAfterInstall(/** @type {ExtendableEvent} */ _event) {
        logger.log('reportAfterInstall');
        await flushPending();
    }

    async function reportOnClientRequest(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(`reportOnClientRequest clientId=${event?.source?.id}`);
    }

    async function reportOnPageLoad(/** @type {ExtendableMessageEvent} */ event) {
        logger.log(
            `reportOnPageLoad clientId=${event?.source?.id} pageUrl=${event?.data?.pageUrl}`
        );
    }

    async function reportOnSync(/** @type {SyncEvent} */ event) {
        logger.log(`reportOnSync lastChance=${event?.lastChance}`);
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
