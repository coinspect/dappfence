import { VERIFICATION_STATUS } from '../../core/constants.js';
import { recoverEthereumAddress, recoverPersonalSign } from '../../core/crypto.js';
import { createLogger } from '../../core/logger.js';

/** @typedef {import('../../core/constants.js').ManifestLoadReason} ManifestLoadReason */
/** @typedef {import('../../core/constants.js').AssetErrorReason} AssetErrorReason */
/** @typedef {import('../../core/constants.js').VerificationStatus} VerificationStatus */

const logger = createLogger();

const MANIFEST_SIGNATURE_TYPES = {
    'noble-secp256k1-recovered-eth': recoverEthereumAddress,
    'personal-sign-alt': recoverPersonalSign,
};

/**
 * Percent-decode a URL pathname for manifest-key comparison. Uses decodeURI
 * (not decodeURIComponent) so URI-reserved characters (`/`, `?`, `#`, `:`, …)
 * stay encoded — `%5B` → `[` matches Next dynamic-route keys like `[id]`, but
 * `%2F` stays encoded so `/api%2Fitem` isn't canonical into `/api/item`
 * and merged with segments the origin kept separate. On malformed input
 * (e.g. a lone `%`) returns the raw pathname — the manifest lookup will miss,
 * which is the correct security outcome.
 *
 * @param {string} pathname
 * @returns {string}
 */
export const decodePathname = (pathname) => {
    try {
        return decodeURI(pathname);
    } catch {
        return pathname;
    }
};

/**
 * Convert a URL to a pathname or full href (no pathRules applied).
 * Same-origin → pathname. Cross-origin → full URL.
 * Used for config URL comparisons (manifest URL self-check).
 *
 * @param {string} url
 * @param {string} baseUrl - The service worker's location href
 * @returns {string}
 */
export const toPathname = (url, baseUrl) => {
    try {
        const fileUrl = new URL(url, baseUrl);
        const originUrl = new URL(baseUrl);
        if (fileUrl.origin === originUrl.origin) {
            return decodePathname(fileUrl.pathname);
        }
        return fileUrl.href;
    } catch (_error) {
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }
};

/**
 * Flat shape — `.status.isViolation` is the branch check at call sites.
 * Producer code (verifyManifestSignature) is responsible for setting the right
 * fields per branch; test coverage + runtime devAsserts catch drift.
 * @typedef {{ status: typeof VERIFICATION_STATUS.MATCH | typeof VERIFICATION_STATUS.MANIFEST_UNTRUSTED, payload?: object, reason?: ManifestLoadReason, expectedHashes?: string[], actualHash?: string }} ManifestSignatureResult
 */

/**
 * Validate manifest data signature using Ethereum-style secp256k1 signature recovery.
 * @param {string} manifestSignatureType
 * @param {string} manifestSignatureIdentity
 * @param {{ pay: object, sig: string }} manifestData - Manifest with .pay (payload) and .sig (signature)
 * @returns {ManifestSignatureResult}
 */
export const verifyManifestSignature = (
    manifestSignatureType,
    manifestSignatureIdentity,
    manifestData
) => {
    if (manifestSignatureType in MANIFEST_SIGNATURE_TYPES) {
        try {
            logger.log('checking signature', manifestSignatureType, manifestData.sig);
            // TextEncoder encodes to UTF-8.
            const msg = new TextEncoder().encode(JSON.stringify(manifestData.pay, null, 2));
            const recovered = MANIFEST_SIGNATURE_TYPES[manifestSignatureType](
                msg,
                manifestData.sig
            );
            if (manifestSignatureIdentity !== recovered) {
                logger.error(
                    `Invalid signature, expected address: ${manifestSignatureIdentity} got ${recovered}`
                );
                return {
                    status: VERIFICATION_STATUS.MANIFEST_UNTRUSTED,
                    reason: 'SIGNATURE_MISMATCH',
                    expectedHashes: [manifestSignatureIdentity],
                    actualHash: recovered,
                };
            }
            logger.log('recovered address', recovered);
            return { status: VERIFICATION_STATUS.MATCH, payload: manifestData.pay };
        } catch (error) {
            logger.error('error validating signature:', error);
            return {
                status: VERIFICATION_STATUS.MANIFEST_UNTRUSTED,
                reason: 'SIGNATURE_ERROR',
            };
        }
    } else {
        logger.error(`unsupported signature type ${manifestSignatureType}`);
        return {
            status: VERIFICATION_STATUS.MANIFEST_UNTRUSTED,
            reason: 'UNSUPPORTED_SIGNATURE',
        };
    }
};
