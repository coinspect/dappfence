/**
 * Verification Results Store
 *
 * One row per non-SKIPPED verifier outcome, bucketed by appVersion. The UI
 * reads this via /sw-api/status to render per-status counts and the
 * "recent verifications" drawer. Capped at 100 rows per bucket.
 *
 * Uses dependency injection: createVerificationResultsStore(database) takes a
 * { get, db } interface, making it testable with in-memory backends.
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/** @typedef {import('../security-processor.js').SecurityEventDetails} SecurityEventDetails */

const VERIFICATION_RESULTS_KEY = 'verification-results';

/**
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createVerificationResultsStore(db) {
    return {
        async get(appVersion) {
            const allResults =
                (await db.read(['verificationResults'], ({ verificationResults }) =>
                    verificationResults.get(VERIFICATION_RESULTS_KEY)
                )) || {};
            return allResults[appVersion] || [];
        },

        /**
         * Persist a verifier outcome. Projection from SecurityEventDetails to the
         * stored shape lives inline — any field not named below is dropped.
         * @param {SecurityEventDetails} details
         */
        async add(details) {
            const appVersion = details.manifestInfo?.appVersion;
            if (!appVersion) {
                logger.log('verificationResultsStore.add: no appVersion on details; skipping');
                return;
            }
            return db.write(['verificationResults'], async ({ verificationResults }) => {
                const allResults = (await verificationResults.get(VERIFICATION_RESULTS_KEY)) || {};
                if (!allResults[appVersion]) {
                    allResults[appVersion] = [];
                }
                allResults[appVersion].push({
                    status: details.status.description,
                    timestamp: new Date().toISOString(),
                    fileKey: details.fileKey,
                    reason: details.reason,
                    expectedHashes: details.expectedHashes,
                    actualHash: details.actualHash,
                });

                if (allResults[appVersion].length > 100) {
                    allResults[appVersion] = allResults[appVersion].slice(-100);
                }

                await verificationResults.put(allResults, VERIFICATION_RESULTS_KEY);
            });
        },
    };
}
