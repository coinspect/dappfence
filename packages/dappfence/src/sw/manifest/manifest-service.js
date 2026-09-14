/**
 * Manifest Service — PR 4a adapter shape
 *
 * Exposes the target public surface (resolveManifest() → { mode, prepareRequest, verifyResponse })
 * while delegating internally to the current operations.js verification primitives.
 * The verifier variants (BasicVerifier, SecurityVerifier) arrive in PR 4b as a DI split
 * inside this file.
 */

import { calculateHash } from '../../core/crypto.js';
import {
    ASSET_TYPE,
    DEFAULT_SECURITY_CONTENT_TYPES,
    DEFAULT_SECURITY_EXTENSIONS,
    isExecutableDestination,
    MODE,
    VERIFICATION_STATUS,
} from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest, isFeatureEnabled } from '../../core/utils.js';
import {
    getFileKey,
    shouldVerifyAsset,
    verifyFilePath,
    verifyManifestSignature,
} from './operations.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

export const createManifestService = ({ swContext, appStore, config }) => {
    const { trustedManifestStore, verificationResultsStore } = appStore;
    const clientIdXManifest = new Map();
    const singleFlight = createSingleFlight();
    const locationHref = swContext.getLocationHref();
    const locationOrigin = swContext.getLocationOrigin();

    // ── manifest fetch/store ───────────────────────────────────────────────

    const loadManifestFromUrl = async () => {
        const { manifestUrl, manifestSignatureType, manifestSignatureIdentity } = config;
        const fileKey = getFileKey(manifestUrl, locationHref);
        const violation = (fields) => ({
            ...fields,
            assetType: ASSET_TYPE.MANIFEST,
            fileKey,
            url: manifestUrl,
        });
        logger.log(`Loading manifest from ${manifestUrl} fileKey: ${fileKey}`);
        try {
            const response = await swContext.fetch(manifestUrl, {
                cache: 'no-cache',
                headers: { 'x-dappfence': 'manifest-load' },
            });
            if (!response || !response.ok) {
                logger.error(
                    `Failed to load manifest: ${response?.status} ${response?.statusText}`
                );
                return violation({ status: VERIFICATION_STATUS.ERROR });
            }
            const json = await response.json();
            const signatureResult = verifyManifestSignature(
                manifestSignatureType,
                manifestSignatureIdentity,
                json
            );
            if (signatureResult.status.isViolation) {
                return violation(signatureResult);
            }
            const { appVersion, manifest } = await trustedManifestStore.addLatest(
                signatureResult.payload
            );
            logger.log(
                `Loaded manifest, app version: ${appVersion.substring(0, 12)}... (${Object.keys(manifest.files).length} files)`
            );
            return { status: VERIFICATION_STATUS.MATCH, manifest, appVersion };
        } catch (error) {
            logger.error('Error loading manifest:', error);
        }
        return violation({ status: VERIFICATION_STATUS.ERROR });
    };

    const fetchAndStoreManifest = async () => {
        if (!hasConfigManifest(config)) {
            return {
                status: VERIFICATION_STATUS.CONFIG_ERROR,
                assetType: ASSET_TYPE.MANIFEST,
                fileKey: config.manifestUrl || 'unknown',
                url: config.manifestUrl || 'unknown',
            };
        }
        return singleFlight(loadManifestFromUrl);
    };

    // ── hash + manifest match (renamed from upstream's inner verifyResponse) ──

    const hashAndCompare = async (fileKey, response, isNavigation, clientId) => {
        const fileHash = await calculateHash(await response.arrayBuffer());
        logger.log(`Verifying file: ${fileKey} hash ${fileHash}`);
        let manifestInfo;
        if (clientId && !isNavigation) {
            manifestInfo = clientIdXManifest.get(clientId);
        }
        if (!manifestInfo) {
            manifestInfo = await trustedManifestStore.findByHash(fileHash);
            if (!manifestInfo || !manifestInfo.appVersion) {
                const violationOrManifest = await fetchAndStoreManifest();
                if (violationOrManifest.status.isViolation) {
                    return violationOrManifest;
                }
                manifestInfo = {
                    appVersion: violationOrManifest.appVersion,
                    manifest: violationOrManifest.manifest,
                };
            }
            if (clientId) {
                clientIdXManifest.set(clientId, manifestInfo);
            }
        }
        logger.log(
            `Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash} clientId ${clientId} ${isNavigation ? 'navigation' : 'no-navigation'}`
        );
        const raw = verifyFilePath(manifestInfo.manifest, fileKey, fileHash, isNavigation);
        // Adapt upstream's verifyFilePath shape ({expectedHash}) to fork's contract
        // ({expectedHashes[], assetType, url}) so storage devAsserts + STATUS_LOG
        // dispatch line up. Adapter-local — PR 4b's BasicVerifier will emit the
        // fork shape directly.
        const { expectedHash, ...rest } = raw;
        const result = {
            ...rest,
            expectedHashes: expectedHash === undefined ? [] : [expectedHash],
            assetType: ASSET_TYPE.ASSET,
        };
        await verificationResultsStore.add(manifestInfo.appVersion, {
            ...result,
            status: result.status.description,
            timestamp: new Date().toISOString(),
        });
        const icon = fileKey.startsWith('/') ? '📄' : '🌐';
        const statusIcon = result.status.isViolation ? '❌' : '✅';
        logger.log(`${statusIcon} ${icon} ${result.status.description}: ${fileKey}`);
        return result;
    };

    const verifyLocation = async (url) => {
        try {
            const response = await swContext.fetch(
                url,
                isFeatureEnabled('mark_request')
                    ? { headers: { 'x-dappfence': 'sw-verification' } }
                    : {}
            );
            if (response && response.ok) {
                const fileKey = getFileKey(url, locationHref);
                return await hashAndCompare(fileKey, response, false, null);
            }
            logger.error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        } catch (error) {
            logger.error(`Error verifying ${url}:`, error);
        }
        return { status: VERIFICATION_STATUS.ERROR };
    };

    // ── request preparation (lifted from upstream fetch-handler.addMarkToRequest,
    //     extended with no-cors → cors upgrade from fork's verifier.prepareRequest.
    //     No allow-rule check — that's contentRules, deferred to PR 5.) ──────────

    const markAndUpgrade = (request) => {
        const url = new URL(request.url);
        const isSameOrigin = url.origin === locationOrigin;
        const isNoCorsExecutable =
            request.mode === 'no-cors' &&
            isExecutableDestination(request.destination) &&
            isFeatureEnabled('force_cors_scripts');

        if (!isNoCorsExecutable) {
            if (!isSameOrigin) {
                logger.log(`[SW-X-ORIGIN] Cross-origin (no tracking): ${request.url}`);
                return request;
            }
            if (!isFeatureEnabled('mark_request')) {
                logger.log(`[SW-NO-TRACKING] No tracking: ${request.url}`);
                return request;
            }
        }

        const createRequest = (overrides) => {
            const req = new Request(url.href, {
                method: request.method,
                credentials: request.credentials,
                cache: request.cache,
                redirect: request.redirect,
                referrer: request.referrer,
                referrerPolicy: request.referrerPolicy,
                integrity: request.integrity,
                ...overrides,
            });
            Object.defineProperty(req, 'destination', {
                value: request.destination,
                configurable: true,
            });
            return req;
        };

        try {
            if (request.mode === 'navigate') {
                logger.log(
                    `[DFSW-NAVIGATE] Navigation request (URL tracking only): ${request.url}`
                );
                return createRequest({
                    headers: new Headers({
                        ...Object.fromEntries(request.headers),
                        'x-dappfence': 'processed',
                    }),
                });
            }
            if (isNoCorsExecutable) {
                logger.log(`[DFSW-NO-CORS] Upgrading no-cors executable to cors: ${request.url}`);
            } else {
                logger.log(`[DFSW-HEADER+URL] Added header to: ${url.href}`);
            }
            const markHeader = isFeatureEnabled('mark_request')
                ? { 'x-dappfence': 'processed' }
                : {};
            return createRequest({
                mode: isNoCorsExecutable ? 'cors' : request.mode,
                credentials: isNoCorsExecutable ? 'omit' : request.credentials,
                headers: new Headers({ ...Object.fromEntries(request.headers), ...markHeader }),
                body: request.body,
                keepalive: request.keepalive,
                signal: request.signal,
            });
        } catch (error) {
            logger.warn(`Failed to prepare request: ${request.url}`, error);
        }
        return request;
    };

    // ── public surface (matches fork's shape) ──────────────────────────────

    const resolveManifest = async () => {
        let latestManifest = await trustedManifestStore.getLatest();
        if (latestManifest) {
            logger.log(
                `Resolved manifest from cache ${latestManifest.appVersion} ${latestManifest.manifest.mode}`
            );
        } else {
            latestManifest = await fetchAndStoreManifest();
            logger.log(
                `Resolved manifest from network ${latestManifest.appVersion} ${latestManifest.manifest?.mode}`
            );
        }
        const mode =
            latestManifest?.manifest?.mode ||
            (isFeatureEnabled('default_to_protected_mode') ? MODE.PROTECTED : MODE.REPORTING);
        const extensions =
            latestManifest?.manifest?.metadata?.extensions || DEFAULT_SECURITY_EXTENSIONS;
        const contentTypes =
            latestManifest?.manifest?.metadata?.contentTypes || DEFAULT_SECURITY_CONTENT_TYPES;

        return {
            mode,
            prepareRequest: markAndUpgrade,
            verifyResponse: async (req, response, clientId = null) => {
                const isNavigation = req.mode === 'navigate';
                const fileKey = getFileKey(req.url, locationHref);
                if (!shouldVerifyAsset(fileKey, isNavigation, response, extensions, contentTypes)) {
                    logger.log(`⏭️  Skipping verification: ${fileKey}`);
                    return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
                }
                return hashAndCompare(fileKey, response.clone(), isNavigation, clientId);
            },
        };
    };

    return {
        fetchAndStoreManifest,
        resolveManifest,
        verifyLocation,
    };
};
