import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { recoverEthereumAddress, recoverPersonalSign } from '../../core/crypto.js';
import { createLogger } from '../../core/logger.js';
import { isFeatureEnabled } from '../../core/utils.js';

const logger = createLogger();

const MANIFEST_SIGNATURE_TYPES = {
    'noble-secp256k1-recovered-eth': recoverEthereumAddress,
    'personal-sign-alt': recoverPersonalSign,
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
            return fileUrl.pathname;
        }
        return fileUrl.href;
    } catch (_error) {
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }
};

/**
 * Validate manifest data signature using Ethereum-style secp256k1 signature recovery.
 * @param {string} manifestSignatureType
 * @param {string} manifestSignatureIdentity
 * @param {object} manifestData - Manifest with .pay (payload) and .sig (signature)
 * @returns {{ status, payload?, expectedHashes?, actualHash? }}
 */
export const verifyManifestSignature = (
    manifestSignatureType,
    manifestSignatureIdentity,
    manifestData
) => {
    if (manifestSignatureType in MANIFEST_SIGNATURE_TYPES) {
        try {
            logger.log('checking signature', manifestSignatureType, manifestData.sig);
            const msg = new TextEncoder('utf-8').encode(JSON.stringify(manifestData.pay, null, 2));
            const recovered = MANIFEST_SIGNATURE_TYPES[manifestSignatureType](
                msg,
                manifestData.sig
            );
            if (manifestSignatureIdentity !== recovered) {
                logger.error(
                    `Invalid signature, expected address: ${manifestSignatureIdentity} got ${recovered}`
                );
                return {
                    status: VERIFICATION_STATUS.MISMATCH,
                    expectedHashes: [manifestSignatureIdentity],
                    actualHash: recovered,
                };
            }
            logger.log('recovered address', recovered);
            return { status: VERIFICATION_STATUS.MATCH, payload: manifestData.pay };
        } catch (error) {
            logger.error('error validating signature:', error);
            return { status: VERIFICATION_STATUS.ERROR };
        }
    } else {
        logger.error(`unsupported signature type ${manifestSignatureType}`);
        return { status: VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE };
    }
};

/**
 * Fetch a URL and verify its content against the trusted manifest.
 * The synthetic destination 'script' is used since importScripts is the primary caller.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.manifestService
 * @param {string} url
 * @returns {Promise<{ status, httpStatus? }>}
 */
export async function verifyLocation({ swContext, manifestService }, url) {
    try {
        const response = await swContext.fetch(
            url,
            isFeatureEnabled('mark_request')
                ? { headers: { 'x-dappfence': 'sw-verification' } }
                : {}
        );
        if (response) {
            if (response.ok) {
                const ctx = await manifestService.resolveManifest();
                return ctx.verifyResponse(
                    { url, destination: 'script', method: 'GET', mode: '' },
                    response
                );
            }
            logger.error(`Failed to fetch ${url}: ${response.status}`);
            return { status: VERIFICATION_STATUS.ERROR, httpStatus: response.status };
        }
        logger.error(`Failed to fetch ${url}: null response`);
    } catch (error) {
        logger.error(`Error verifying ${url}:`, error);
    }
    return { status: VERIFICATION_STATUS.ERROR };
}

/**
 * Verify an imported script against the trusted manifest.
 * @param {object} deps
 * @param {object} deps.manifestService
 * @param {object} deps.appStore
 * @param {object} deps.swContext
 * @param {string} scriptPath
 */
export async function verifyImportedScript(deps, scriptPath) {
    const fileKey = toPathname(scriptPath, deps.swContext.getLocationHref());
    const verificationResult = await verifyLocation(deps, scriptPath);
    if (verificationResult.status.isViolation) {
        await deps.appStore.recordSecurityViolation({
            ...verificationResult,
            url: scriptPath,
            fileKey,
            assetType: ASSET_TYPE.SERVICE_WORKER,
        });
        logger.log(
            `Security violation detected for ${scriptPath}: ${verificationResult.status.description}`
        );
        return;
    }
    logger.log(`Script verified: ${scriptPath}`);
}
