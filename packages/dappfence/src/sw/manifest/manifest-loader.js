/**
 * Manifest Loader
 * Owns the boundary between raw external manifest JSON and the normalized
 * in-memory shape: fetching, signature verification, normalization, and store
 * handoff.
 */

import { ASSET_TYPE, MODE, VERIFICATION_STATUS } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest } from '../../core/utils.js';
import { toPathname, verifyManifestSignature } from './verification.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * Normalize raw manifest input into the shape the SW consumes.
 *
 * `files` entries may be a single hash string, an array of hash strings, or
 * `{ hash }` objects; all forms collapse to a string[] so downstream verifiers
 * can `.includes(actualHash)` uniformly. Arrays support CDN-served assets
 * whose bytes vary across regions or releases — every known-good hash
 * verifies while unexpected content still blocks.
 */
export const normalizeManifestData = (manifestData) => {
    const toArray = (entry) => {
        if (Array.isArray(entry)) {
            return entry;
        }
        if (typeof entry === 'string') {
            return [entry];
        }
        if (entry?.hash) {
            return [entry.hash];
        }
        return [];
    };

    const normalizedFiles = {};
    if (typeof manifestData === 'object' && manifestData !== null) {
        const source =
            manifestData.files && typeof manifestData.files === 'object'
                ? manifestData.files
                : manifestData;
        for (const [filePath, entry] of Object.entries(source)) {
            normalizedFiles[filePath] = toArray(entry);
        }
    }

    return {
        ...(typeof manifestData === 'object' && manifestData !== null ? manifestData : {}),
        files: normalizedFiles,
        pathRules: Array.isArray(manifestData?.pathRules) ? manifestData.pathRules : [],
        mode: manifestData?.mode ?? MODE.REPORTING,
    };
};

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
                normalizeManifestData(signatureResult.payload)
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
