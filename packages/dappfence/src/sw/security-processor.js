import { devAssert } from '../core/utils.js';
import { ASSET_TYPE, VERIFICATION_STATUS } from '../core/constants.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger();

/** @typedef {import('../core/constants.js').AssetType} AssetType */
/** @typedef {import('../core/constants.js').VerificationStatus} VerificationStatus */
/** @typedef {import('../core/constants.js').AssetErrorReason} AssetErrorReason */
/** @typedef {import('../core/constants.js').FileUntrustedReason} FileUntrustedReason */
/** @typedef {import('../core/constants.js').ManifestLoadReason} ManifestLoadReason */

/**
 * @typedef {{
 *   status: VerificationStatus,
 *   assetType: AssetType,
 *   fileKey: string,
 *   url: string,
 *   reason?: AssetErrorReason | FileUntrustedReason | ManifestLoadReason,
 *   actualHash?: string,
 *   expectedHashes?: string[],
 *   httpStatus?: number,
 * }} ViolationDetails
 */

/**
 * Formatter signature for a status log entry.
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
 * Extracted from storage/index.js so storage stays as pure stores.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 */
export function createSecurityProcessor({ swContext, appStore }) {
    const { securityEventsStore, activeBlocksStore } = appStore;
    const userAgent = swContext.getUserAgent();
    const origin = swContext.getLocationOrigin();

    /**
     * Logs a security event and, when the status is a violation, records the block.
     * MATCH/SKIPPED are no-ops; non-violation telemetry statuses (REWRITE/CSP_PROTECTED)
     * are logged to the events store but never activate a block. Recurrences of
     * already-known blocks are logged but return false. Storage failures fail-safe
     * and return true.
     * @param {ViolationDetails} details
     * @returns {Promise<boolean>} mustBlock
     */
    async function recordSecurityViolation(details) {
        devAssert(details.status && typeof details.status.description === 'string');
        if (
            details.status === VERIFICATION_STATUS.MATCH ||
            details.status === VERIFICATION_STATUS.SKIPPED
        ) {
            return false;
        }
        devAssert(Object.values(ASSET_TYPE).includes(details.assetType));
        devAssert(details.url);
        devAssert(details.fileKey);
        try {
            const statusName = details.status.description;
            const persistedDetails = {
                status: statusName,
                reason: details.reason,
                fileKey: details.fileKey,
                url: details.url,
                assetType: details.assetType,
                expectedHashes: details.expectedHashes,
                actualHash: details.actualHash,
                httpStatus: details.httpStatus,
            };
            const method = details.status.isViolation ? 'error' : 'log';
            const logArgs =
                STATUS_LOG[statusName] ??
                ((d) => [
                    `SECURITY ALERT: {${statusName}}`,
                    `URL: ${d.url ?? 'N/A'}`,
                    `File: ${d.fileKey ?? 'N/A'}`,
                ]);
            logger[method](...logArgs(details));

            try {
                await securityEventsStore.logSecurityEvent({
                    type: 'SECURITY_VIOLATION',
                    status: statusName,
                    reason: details.reason,
                    assetType: details.assetType,
                    timestamp: new Date().toISOString(),
                    url: details.url,
                    fileKey: details.fileKey,
                    expectedHashes: details.expectedHashes,
                    actualHash: details.actualHash,
                    httpStatus: details.httpStatus,
                    userAgent,
                    origin,
                });
            } catch (error) {
                logger.error('Failed to store security log:', error);
            }

            if (!details.status.isViolation) {
                logger.log(`Security violation skipped: ${statusName} - ${details.fileKey}`);
                return false;
            }
            const mustBlock = await activeBlocksStore.recordSecurityBlock(persistedDetails);
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
            logger.error('Failed to handle security violation:', error);
            return true;
        }
    }

    return {
        recordSecurityViolation,
    };
}
