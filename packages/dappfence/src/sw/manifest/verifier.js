/**
 * File Verifier
 * Rule engine: content rule matching, action pipeline, and file hash verification.
 *
 * Manifest escalation for unpinned clients (MISMATCH / NOT_FOUND only):
 *   1. latestManifest (caller-supplied, IndexedDB cache)
 *   2. getManifestHistory — stored historic manifests, newest-first
 *   3. fetchAndStoreManifest — force network fetch (terminal)
 *
 * Any other result (MATCH, SKIPPED, REWRITE, DENIED_BY_RULE, ERROR) stops
 * escalation immediately — see manifestDecided().
 *
 * Pinned clients skip escalation entirely: their manifest is the truth for the
 * page load, so any failure is a genuine violation.
 */

import { ASSET_TYPE, isExecutableDestination, VERIFICATION_STATUS } from '../../core/constants.js';
import { collectContentRuleActions, isRequestAllowed, resolveManifestKey } from './rules.js';
import { isFeatureEnabled } from '../../core/utils.js';
import { toPathname } from './verification.js';
import { createLogger } from '../../core/logger.js';
import { calculateHash } from '../../core/crypto.js';
import { makeResponseWrapper } from './html/response-wrapper.js';
import { handleTransform } from './html/transforms.js';

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
export const createVerifier = ({ swContext, appStore, config }, manifestLoader) => {
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
        logger.log(
            `shouldSkipVerification ${req.url} ${req.method} destination=${destination} response.ok=${response?.ok} response.type=${response?.type}`
        );
        const skip = (reason) => {
            logger.log(`⏭️ Skipping: ${reason} ${req.url}`);
            return VERIFICATION_STATUS.SKIPPED;
        };

        const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
        if (req.method !== 'GET' && !isPostNavigation) {
            return skip('non-GET/non-POST-navigate request');
        }
        if (!destination) return skip('programmatic fetch (destination="")');
        if (response.type === 'opaqueredirect' || response.type === 'error') {
            return skip(`empty body, response type ${response.type}`);
        }
        if (response.type === 'opaque') {
            if (!isExecutableDestination(destination)) {
                return skip('non-executable opaque');
            }
            // prepareRequest upgrades no-cors executable requests to cors+omit; if we
            // still get an opaque response, the body is unreadable — stub it.
            // (allow rules are checked before this point so allowed embeds never reach here.)
            logger.log(`↩️  Rewriting opaque executable ${req.url}`);
            return VERIFICATION_STATUS.REWRITE;
        }
        if (!response.ok && !isExecutableDestination(destination)) {
            return skip('non-ok sub-resource');
        }
        return false;
    };

    const ACTION_HANDLERS = {
        allow: async (fileKey) => {
            logger.log(`⏭️  Skipping (allow): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED };
        },
        deny: async (fileKey) => {
            logger.log(`❌ Denied by rule: ${fileKey}`);
            return { status: VERIFICATION_STATUS.DENIED_BY_RULE };
        },
        rewrite: async (fileKey) => {
            logger.log(`↩️  Rewriting by rule: ${fileKey}`);
            return { status: VERIFICATION_STATUS.REWRITE };
        },
        transform: handleTransform,
        verify: async (fileKey, response, manifestInfo) => {
            const bytes = await response.getBodyBytes();
            if (bytes.status) {
                return bytes;
            }
            const { appVersion, manifest } = manifestInfo;
            const actualHash = await calculateHash(bytes.value);
            const expectedHashes = manifest.files[fileKey] ?? [];
            logger.log(
                `Using manifest ${appVersion} for ${fileKey} hash ${actualHash} expected: ${expectedHashes.join(', ')}`
            );
            if (expectedHashes.length === 0) {
                return null;
            }
            if (expectedHashes.includes(actualHash)) {
                return { status: VERIFICATION_STATUS.MATCH, expectedHashes, actualHash };
            }
            return {
                status: VERIFICATION_STATUS.MISMATCH,
                keepTryingActions: true,
                expectedHashes,
                actualHash,
            };
        },
    };

    const evaluateManifestRules = async (req, response, manifestInfo) => {
        const { manifest } = manifestInfo;
        const fileKey = resolveManifestKey(req, locationHref, manifest, response);
        const actions = collectContentRuleActions(fileKey, req.destination, manifest?.contentRules);
        const actionsToWalk = actions.length ? actions : [{ type: 'verify' }];
        let lastResult = { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST };
        for (const action of actionsToWalk) {
            logger.log(
                `[evaluateManifestRules] fileKey=${fileKey} action.type=${action.type}${action.transform ? ` transform=${action.transform}` : ''}`
            );
            const handler = ACTION_HANDLERS[action.type];
            if (!handler) {
                logger.warn(`Unknown action type: ${action.type}`);
                continue;
            }
            const r = await handler(fileKey, response, manifestInfo, action);
            if (r === null) {
                continue;
            }
            if (r.keepTryingActions) {
                lastResult = r;
                continue;
            }
            logger.log(`❌ result: ${r.status.description}: ${fileKey}`);
            return { ...r, fileKey };
        }
        logger.log(`❌ lastResult: ${lastResult.status.description}: ${fileKey}`);
        return { ...lastResult, fileKey };
    };

    // For unpinned clients, escalate from the latest manifest → historic manifests → network fetch
    // on MISMATCH / NOT_FOUND / ERROR only. All other results (MATCH, DENIED_BY_RULE, etc.) are final.
    const verifyWithManifestSearch = async (req, response, clientId, latestManifest) => {
        const isNavigation = req.mode === 'navigate';
        if (clientId && !isNavigation) {
            const pinned = clientIdXManifest.get(clientId);
            if (pinned) {
                logger.log(`[verifyResponse] clientId=${clientId} (pinned)`);
                const result = await evaluateManifestRules(req, response, pinned);
                onManifestResult(pinned, result);
                return result;
            }
        }

        const triedVersions = new Set();
        const tryManifest = async (manifestInfo) => {
            if (
                !manifestInfo ||
                !manifestInfo.manifest ||
                triedVersions.has(manifestInfo.appVersion)
            ) {
                return null;
            }
            triedVersions.add(manifestInfo.appVersion);
            const result = await evaluateManifestRules(req, response, manifestInfo);
            onManifestResult(manifestInfo, result);
            return result;
        };

        const latestResult = await tryManifest(latestManifest);
        if (manifestDecidedAbout(latestResult)) {
            pinClient(clientId, latestManifest);
            return latestResult;
        }

        // Try all stored historic manifests newest-first, skipping already tried.
        // Each is run through the full pipeline, so transforms are applied correctly.
        const historicResults = [];
        for (const manifestInfo of await getManifestHistory()) {
            const result = await tryManifest(manifestInfo);
            if (manifestDecidedAbout(result)) {
                pinClient(clientId, manifestInfo);
                return result;
            }
            historicResults.push(result);
        }

        const fetched = await fetchAndStoreManifest();
        const fetchedResult = await tryManifest(fetched);
        if (manifestDecidedAbout(fetchedResult)) {
            pinClient(clientId, fetched);
            return fetchedResult;
        }
        // Nothing decided — return best available non-null result.
        return [fetchedResult, latestResult, ...historicResults].find((r) => r !== null) ?? fetched;
    };

    const verifyResponse = async (req, response, clientId, latestManifest) => {
        const fileKey = toPathname(req.url, locationHref);
        // fileKey from fields overrides the default (resolveManifestKey may differ);
        // assetType is last so it always wins.
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

        // Allow rule pre-check: if the manifest explicitly allows this request,
        // skip verification before shouldSkipVerification runs — so the opaque
        // REWRITE path never fires for intentionally un-upgraded resources (e.g.
        // cross-origin embeds/objects on CDNs that don't support CORS).
        if (isRequestAllowed(req, locationHref, latestManifest?.manifest)) {
            logger.log(`⏭️  Skipping (allow rule): ${req.url}`);
            return result({ status: VERIFICATION_STATUS.SKIPPED });
        }
        const wrappedResponse = makeResponseWrapper(response);
        const shouldSkip = shouldSkipVerification(req, wrappedResponse);
        if (shouldSkip) {
            logger.log(`⏭️  ${shouldSkip.description}: ${fileKey}`);
            return result({ status: shouldSkip });
        }

        logger.log(
            `[verifyResponse] req.method=${req.method} clientId=${clientId} isNavigation=${req.mode === 'navigate'}`
        );
        return result(
            await verifyWithManifestSearch(req, wrappedResponse, clientId, latestManifest)
        );
    };

    // ── prepareRequest ────────────────────────────────────────────────────────
    // Upgrades no-cors executable requests to cors+omit, so the response body is
    // readable, unless a contentRule with action `allow` matches the request
    // (e.g., embed/object allow rules for PDF CDNs that don't support CORS).
    // Adds DappFence tracking markers on same-origin requests when mark_request
    // is enabled.
    //
    // Request properties are prototype getters, not own enumerable properties, so
    // `{ ...request }` yields `{}`. We must list each property explicitly.
    const prepareRequest = (request, latestManifest) => {
        const url = new URL(request.url);
        const isSameOrigin = url.origin === locationOrigin;

        const isNoCorsExecutable =
            request.mode === 'no-cors' &&
            isExecutableDestination(request.destination) &&
            isFeatureEnabled('force_cors_scripts');

        if (
            isNoCorsExecutable &&
            isRequestAllowed(request, locationHref, latestManifest?.manifest)
        ) {
            logger.log(`[DFSW-NO-CORS-ALLOW] Skipping CORS upgrade (allow rule): ${request.url}`);
            return request;
        }

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
