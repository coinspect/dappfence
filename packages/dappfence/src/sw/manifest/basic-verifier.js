/**
 * Verifier — hashes every verifiable response and matches against the
 * manifest's `files` map. Uses pathRules to canonicalize URL → manifest key.
 *
 * Manifest escalation for unpinned clients (MISMATCH / NOT_FOUND / ERROR /
 * UNSUPPORTED_SIGNATURE only):
 *   1. latestManifest (caller-supplied, IndexedDB cache)
 *   2. getManifestHistory — stored historic manifests, newest-first
 *   3. fetchAndStoreManifest — force network fetch (terminal)
 *
 * Any other outcome (MATCH, SKIPPED, REWRITE) stops escalation. Pinned clients
 * skip escalation entirely: their manifest is the truth for the page load, so
 * any failure is a genuine violation.
 */

import { ASSET_TYPE, isExecutableDestination, VERIFICATION_STATUS } from '../../core/constants.js';
import { isFeatureEnabled } from '../../core/utils.js';
import { toPathname } from './verification.js';
import { resolveManifestKey } from './rules.js';
import { createLogger } from '../../core/logger.js';
import { calculateHash } from '../../core/crypto.js';

const logger = createLogger();

// Statuses that mean "this manifest version couldn't cover this file" or
// "this manifest is broken" — escalate to a newer or historic version.
// Any other outcome is a real policy decision that must not be bypassed.
// null means tryManifest skipped the manifest entirely; keep escalating.
const ESCALATE_STATUSES = new Set([
    VERIFICATION_STATUS.MISMATCH,
    VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST,
    VERIFICATION_STATUS.ERROR,
    VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE,
]);
const manifestDecidedAbout = (result) => result !== null && !ESCALATE_STATUSES.has(result.status);

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 * @param {object} manifestLoader
 */
export const createBasicVerifier = ({ swContext, appStore, config }, manifestLoader) => {
    const { storeManifestFromResponse, fetchAndStoreManifest, getManifestHistory } = manifestLoader;
    const { verificationResultsStore } = appStore;
    const locationHref = swContext.getLocationHref();
    const locationOrigin = new URL(locationHref).origin;
    const manifestFileKey = config.manifestUrl
        ? toPathname(config.manifestUrl, locationHref)
        : null;
    const clientIdXManifest = new Map();

    const onManifestResult = (manifestInfo, result) => {
        if (result.status !== VERIFICATION_STATUS.MATCH) {
            logger.log(`❌ ${result.status.description}: ${result.fileKey}`);
            return;
        }
        const icon = result.fileKey.startsWith('/') ? '📄' : '🌐';
        logger.log(`✅ ${icon} ${result.status.description}: ${result.fileKey}`);
        verificationResultsStore
            .add(manifestInfo.appVersion, {
                ...result,
                status: result.status.description,
                timestamp: new Date().toISOString(),
            })
            .catch((err) => logger.error('Error storing verification result:', err));
    };

    const pinClient = (clientId, manifestInfo) => {
        if (!clientId) {
            return;
        }
        clientIdXManifest.set(clientId, manifestInfo);
        swContext
            .matchAllClients()
            .then((activeClients) => {
                const activeIds = new Set(activeClients.map((c) => c.id));
                for (const id of clientIdXManifest.keys()) {
                    if (!activeIds.has(id)) {
                        clientIdXManifest.delete(id);
                    }
                }
            })
            .catch((err) => {
                logger.error('Error pruning stale clients:', err);
            });
    };

    const shouldSkipVerification = (req, response) => {
        const { destination } = req;
        const skip = (reason) => {
            logger.log(`⏭️ Skipping: ${reason} ${req.url}`);
            return VERIFICATION_STATUS.SKIPPED;
        };

        const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
        if (req.method !== 'GET' && !isPostNavigation) {
            return skip('non-GET/non-POST-navigate request');
        }
        if (!destination) {
            return skip('programmatic fetch (destination="")');
        }
        if (response.type === 'opaqueredirect' || response.type === 'error') {
            return skip(`empty body, response type ${response.type}`);
        }
        if (response.type === 'opaque') {
            if (!isExecutableDestination(destination)) {
                return skip('non-executable opaque');
            }
            // prepareRequest upgrades no-cors executable requests to cors+omit; if we
            // still get an opaque response, the body is unreadable — stub it.
            logger.log(`↩️  Rewriting opaque executable ${req.url}`);
            return VERIFICATION_STATUS.REWRITE;
        }
        if (!response.ok && !isExecutableDestination(destination)) {
            return skip('non-ok sub-resource');
        }
        return null;
    };

    // Single hash+match pass against one manifest. No dispatch table — basic
    // mode has only the verify action.
    const evaluateManifest = (req, response, manifestInfo, actualHash) => {
        const { manifest, appVersion } = manifestInfo;
        const fileKey = resolveManifestKey(req, locationHref, manifest, response);
        const expectedHashes = manifest.files[fileKey] ?? [];
        logger.log(
            `Using manifest ${appVersion} for ${fileKey} hash ${actualHash} expected: ${expectedHashes.join(', ')}`
        );
        if (expectedHashes.length === 0) {
            return { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey, actualHash };
        }
        if (expectedHashes.includes(actualHash)) {
            return { status: VERIFICATION_STATUS.MATCH, fileKey, expectedHashes, actualHash };
        }
        return { status: VERIFICATION_STATUS.MISMATCH, fileKey, expectedHashes, actualHash };
    };

    // For unpinned clients, escalate from the latest manifest → historic manifests → network fetch
    // on MISMATCH / NOT_FOUND / ERROR only. All other results (MATCH, etc.) are final.
    const verifyWithManifestSearch = async (
        req,
        response,
        actualHash,
        clientId,
        latestManifest
    ) => {
        const isNavigation = req.mode === 'navigate';
        if (clientId && !isNavigation) {
            const pinned = clientIdXManifest.get(clientId);
            if (pinned) {
                logger.log(`[verifyResponse] clientId=${clientId} (pinned)`);
                const result = evaluateManifest(req, response, pinned, actualHash);
                onManifestResult(pinned, result);
                return result;
            }
        }

        const triedVersions = new Set();
        const tryManifest = (manifestInfo) => {
            if (
                !manifestInfo ||
                !manifestInfo.manifest ||
                triedVersions.has(manifestInfo.appVersion)
            ) {
                return null;
            }
            triedVersions.add(manifestInfo.appVersion);
            const result = evaluateManifest(req, response, manifestInfo, actualHash);
            onManifestResult(manifestInfo, result);
            return result;
        };

        const latestResult = tryManifest(latestManifest);
        if (manifestDecidedAbout(latestResult)) {
            pinClient(clientId, latestManifest);
            return latestResult;
        }

        const historicResults = [];
        for (const manifestInfo of await getManifestHistory()) {
            const result = tryManifest(manifestInfo);
            if (manifestDecidedAbout(result)) {
                pinClient(clientId, manifestInfo);
                return result;
            }
            historicResults.push(result);
        }

        const fetched = await fetchAndStoreManifest();
        const fetchedResult = tryManifest(fetched);
        if (manifestDecidedAbout(fetchedResult)) {
            pinClient(clientId, fetched);
            return fetchedResult;
        }
        return [fetchedResult, latestResult, ...historicResults].find((r) => r !== null) ?? fetched;
    };

    const verifyResponse = async (req, response, clientId, latestManifest) => {
        const fileKey = toPathname(req.url, locationHref);
        const result = (fields) => ({
            fileKey,
            url: req.url,
            ...fields,
            assetType: ASSET_TYPE.ASSET,
        });

        if (!response) {
            logger.log(`⏭️  Error: null response`);
            return result({ status: VERIFICATION_STATUS.ERROR });
        }

        if (fileKey === manifestFileKey) {
            return await storeManifestFromResponse(response.clone());
        }

        const shouldSkip = shouldSkipVerification(req, response);
        if (shouldSkip) {
            return result({ status: shouldSkip });
        }

        const bytes = await response.clone().arrayBuffer();
        const actualHash = await calculateHash(bytes);

        logger.log(
            `[verifyResponse] req.method=${req.method} clientId=${clientId} isNavigation=${req.mode === 'navigate'} hash=${actualHash}`
        );
        return result(
            await verifyWithManifestSearch(req, response, actualHash, clientId, latestManifest)
        );
    };

    // ── prepareRequest ────────────────────────────────────────────────────────
    // Upgrades no-cors executable requests to cors+omit, so the response body is
    // readable. Adds DappFence tracking markers on same-origin requests when
    // mark_request is enabled.
    //
    // Request properties are prototype getters, not own enumerable properties, so
    // `{ ...request }` yields `{}`. We must list each property explicitly.
    const prepareRequest = (request) => {
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

    return { verifyResponse, prepareRequest };
};
