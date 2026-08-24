/**
 * Manifest Loader
 * Handles manifest fetching, signature verification, and storage.
 */

import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest } from '../../core/utils.js';
import { toPathname, verifyManifestSignature } from './verification.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config - Must include manifestUrl, manifestSignatureType, manifestSignatureIdentity
 */
export const createManifestLoader = ({ swContext, appStore, config }) => {
    const { trustedManifestStore } = appStore;
    const singleFlight = createSingleFlight();
    const { manifestUrl, manifestSignatureType, manifestSignatureIdentity } = config;
    const manifestFileKey = manifestUrl
        ? toPathname(manifestUrl, swContext.getLocationHref())
        : null;

    // Stamp every result with the manifest identity fields so callers never
    // have to repeat them and recordSecurityViolation can assert they're present.
    const manifestResult = (fields) => ({
        url: manifestUrl,
        fileKey: manifestFileKey,
        assetType: ASSET_TYPE.MANIFEST,
        ...fields,
    });

    const storeManifestFromResponse = async (response) => {
        try {
            const json = await response.json();
            const signatureResult = verifyManifestSignature(
                manifestSignatureType,
                manifestSignatureIdentity,
                json
            );
            if (signatureResult.status.isViolation) {
                return manifestResult(signatureResult);
            }
            const { appVersion, manifest } = await trustedManifestStore.addLatest(
                signatureResult.payload
            );
            logger.log(
                `Loaded manifest, app version: ${appVersion.substring(0, 12)}... (${Object.keys(manifest.files).length} files)`
            );
            return manifestResult({ status: VERIFICATION_STATUS.MATCH, manifest, appVersion });
        } catch (error) {
            logger.error('Error processing manifest:', error);
            return manifestResult({ status: VERIFICATION_STATUS.ERROR });
        }
    };

    const loadManifestFromUrl = async () => {
        logger.log(`Loading manifest from ${manifestUrl} fileKey: ${manifestFileKey}`);
        try {
            const response = await swContext.fetch(manifestUrl, {
                cache: 'no-cache',
                headers: { 'x-dappfence': 'manifest-load' },
            });
            if (response && response?.ok) {
                return storeManifestFromResponse(response);
            }
            logger.error(`Failed to load manifest: ${response?.status} ${response?.statusText}`);
            return manifestResult({
                status: VERIFICATION_STATUS.ERROR,
                httpStatus: response?.status,
            });
        } catch (error) {
            logger.error('Error loading manifest:', error);
        }
        return manifestResult({ status: VERIFICATION_STATUS.ERROR });
    };

    const fetchAndStoreManifest = async () => {
        if (!hasConfigManifest(config)) {
            return manifestResult({ status: VERIFICATION_STATUS.CONFIG_ERROR });
        }
        return singleFlight(loadManifestFromUrl);
    };

    const resolveLatest = async () => {
        const cached = await trustedManifestStore.getLatest();
        if (cached) {
            logger.log(`Resolved manifest from cache ${cached.appVersion} ${cached.manifest.mode}`);
            return cached;
        }
        const fetched = await fetchAndStoreManifest();
        logger.log(
            `Resolved manifest from network ${fetched?.appVersion} ${fetched?.manifest?.mode}`
        );
        return fetched;
    };

    return {
        storeManifestFromResponse,
        fetchAndStoreManifest,
        resolveLatest,
        getManifestHistory: trustedManifestStore.getAll,
    };
};
