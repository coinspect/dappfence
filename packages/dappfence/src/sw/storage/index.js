/**
 * App Store Facade
 *
 * Manifest Store properties (trustedManifest, verificationResults)
 * are spread at the top level since they're already uniquely named.
 * The other three are grouped objects.
 *
 * @param {object} db - Low-level Store backend from createDatabase()
 * @param {object} env - Environment info for log enrichment
 * @param {string} env.userAgent
 * @param {string} env.origin
 */
import { devAssert } from '../../core/utils.js';
import { createLogger } from '../../core/logger.js';
import { ASSET_TYPE } from '../../core/constants.js';
import { createManifestStore } from './manifest-store.js';
import {
    createActiveBlocksStore,
    createSecurityEventsStore,
    createApiTokenStore,
} from './security-stores.js';

const logger = createLogger();

const STATUS_LOG = {
    MATCH: (d) => [`SW file verification passed: ${d.fileKey}`],
    SKIPPED: (d) => [`SW file verification skipped: ${d.fileKey}`],
    REWRITE: (d) => [`SW file response rewritten: ${d.fileKey}`],
    MISMATCH: (d) => [
        `SECURITY ALERT: Service Worker file integrity violation!`,
        `File: ${d.url}\nExpected: ${d.expectedHashes?.join(', ')}`,
        `Actual: ${d.actualHash}`,
    ],
    NOT_FOUND_IN_MANIFEST: (d) => [
        `SECURITY ALERT: Unknown file not in trusted manifest!`,
        `File: ${d.fileKey}`,
        `Hash: ${d.actualHash}`,
    ],
    DENIED_BY_RULE: (d) => [`SECURITY ALERT: File denied by security rule!`, `File: ${d.fileKey}`],
    UNSUPPORTED_SIGNATURE: (d) => [
        `SECURITY ALERT: Manifest signature algorithm not supported!`,
        `File: ${d.fileKey}`,
    ],
    VERIFICATION_ERROR: (d) => [
        `SECURITY ALERT: Verification error!`,
        `File: ${d.fileKey ?? 'N/A'}`,
    ],
    CONFIG_ERROR: (d) => [
        `SECURITY ALERT: Security configuration error!`,
        `File: ${d.fileKey ?? 'N/A'}`,
    ],
};

export function createAppStore(db, { userAgent, origin } = {}) {
    const activeBlocksStore = createActiveBlocksStore(db);
    const securityEventsStore = createSecurityEventsStore(db);

    /**
     * Logs a security violation event and records the block.
     * Returns whether the caller must block the current request. Recurrences of
     * already-known blocks (including previously cleared ones) are still logged
     * and counted, but return false. Storage failures fail-safe and return true.
     * @param {object} details - Violation details (status, fileKey, url, expectedHashes, actualHash, assetType)
     * @returns {Promise<boolean>} mustBlock — true if the caller should block the request
     */
    async function recordSecurityViolation(details) {
        devAssert(details.status && typeof details.status.description === 'string');
        devAssert(Object.values(ASSET_TYPE).includes(details.assetType));
        devAssert(details.url);
        devAssert(details.fileKey);
        try {
            // status is the runtime verdict object; persistence + log lines want
            // the description string. Normalize once and use it everywhere below.
            const statusName = details.status.description;
            const persistedDetails = { ...details, status: statusName };
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
            // Fail-safe: on unexpected error, tell the caller to block.
            return true;
        }
    }

    return {
        ...createManifestStore(db),
        activeBlocksStore,
        securityEventsStore,
        apiTokenStore: createApiTokenStore(db),
        recordSecurityViolation,
    };
}
