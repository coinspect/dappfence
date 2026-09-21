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

// Reads a build-time flag with a caller-supplied default. Not `isFeatureEnabled`
// because it collapses "missing" and "explicitly false" — the tri-state needs both.
const flagOrDefault = (name, defaultValue) => {
    if (typeof __FEATURES__ === 'undefined' || __FEATURES__ === null) {
        return defaultValue;
    }
    const v = __FEATURES__[name];
    if (v === undefined) {
        return defaultValue;
    }
    return v === true;
};

/**
 * Normalize raw manifest input into the shape the SW consumes.
 *
 * `files` entries may be a single hash string, an array of hash strings, or
 * `{ hash }` objects; all forms collapse to a string[] so downstream verifiers
 * can `.includes(actualHash)` uniformly. Arrays support CDN-served assets
 * whose bytes vary across regions or releases — every known-good hash
 * verifies while unexpected content still blocks.
 *
 * The `csp` block always resolves to a fully-populated shape so downstream
 * `buildCspHeader` never has to consult feature flags itself. The tri-state
 * (`upgradeInsecureRequests`, `reportSample`) is resolved here against the
 * `csp_upgrade_insecure_requests` and `csp_report_sample` build-time flags.
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

    const rawCsp =
        manifestData?.csp && typeof manifestData.csp === 'object' ? manifestData.csp : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const csp = {
        // Integrator opt-out: `enabled: false` disables CSP header injection
        // entirely for this manifest. When disabled the SW leaves the origin's
        // CSP headers (if any) untouched. Defaults to true; missing manifest.csp
        // or missing `enabled` field both keep CSP on.
        enabled: rawCsp.enabled !== false,
        scriptOrigins: arr(rawCsp.scriptOrigins),
        connectOrigins: arr(rawCsp.connectOrigins),
        formActionOrigins: arr(rawCsp.formActionOrigins),
        frameOrigins: arr(rawCsp.frameOrigins),
        mediaOrigins: arr(rawCsp.mediaOrigins),
        manifestSrcOrigins: arr(rawCsp.manifestSrcOrigins),
        imgOrigins: arr(rawCsp.imgOrigins),
        fontOrigins: arr(rawCsp.fontOrigins),
        styleOrigins: arr(rawCsp.styleOrigins),
        frameAncestors: arr(rawCsp.frameAncestors),
        upgradeInsecureRequests:
            typeof rawCsp.upgradeInsecureRequests === 'boolean'
                ? rawCsp.upgradeInsecureRequests
                : flagOrDefault('csp_upgrade_insecure_requests', true),
        reportSample:
            typeof rawCsp.reportSample === 'boolean'
                ? rawCsp.reportSample
                : flagOrDefault('csp_report_sample', false),
        pages:
            rawCsp.pages && typeof rawCsp.pages === 'object' && !Array.isArray(rawCsp.pages)
                ? rawCsp.pages
                : {},
    };

    return {
        ...(typeof manifestData === 'object' && manifestData !== null ? manifestData : {}),
        files: normalizedFiles,
        pathRules: Array.isArray(manifestData?.pathRules) ? manifestData.pathRules : [],
        contentRules: Array.isArray(manifestData?.contentRules) ? manifestData.contentRules : [],
        mode: manifestData?.mode ?? MODE.REPORTING,
        csp,
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
