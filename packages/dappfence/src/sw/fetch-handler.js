/**
 * Security Fetch Handler Module
 * Orchestrates security checks and app service worker integration
 */

import { createBlockResponse } from './response.js';
import { createLogger } from '../core/logger.js';
import { API_PREFIX, ASSET_TYPE, MODE } from '../core/constants.js';
import { isFeatureEnabled } from '../core/utils.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext - Service worker context wrapper
 * @param {object} deps.manifestService - Manifest verification service
 * @param {function} deps.onSecurityViolation - Called to broadcast the block condition
 * @param {object} deps.appStore - App store facade
 * @returns {function} Fetch event handler (event, callChildHandlers) => Promise<Response>
 */
export function createSecurityFetchHandler({
    swContext,
    manifestService,
    onSecurityViolation,
    appStore,
    handleApiEndpoint,
}) {
    const { activeBlocksStore } = appStore;
    const locationOrigin = swContext.getLocationOrigin();
    const locationHref = swContext.getLocationHref();

    /**
     * Add DappFence tracking markers to the request.
     * Pure function — takes originUrl as a string so it can be tested without swContext.
     */
    function addMarkToRequest(event, request) {
        const requestUrl = new URL(request.url);
        const isSameOrigin = requestUrl.origin === locationOrigin;

        if (!isSameOrigin) {
            logger.log(`[SW-X-ORIGIN] Cross-origin (no tracking): ${request.url}`);
            return request; // Can't modify cross-origin requests
        }

        try {
            // Create URL with SW tracking parameter
            const modifiedUrl = new URL(request.url);
            // modifiedUrl.searchParams.set('sw', '1');

            let modifiedRequest;

            // Handle navigation requests differently (they can't be fully cloned)
            if (request.mode === 'navigate') {
                logger.log(
                    `[DFSW-NAVIGATE] Navigation request (URL tracking only): ${request.url}`
                );
                modifiedRequest = new Request(modifiedUrl.href, {
                    method: request.method,
                    headers: new Headers({
                        ...Object.fromEntries(request.headers),
                        'x-dappfence': 'processed',
                    }),
                    credentials: request.credentials,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy,
                    cache: request.cache,
                    integrity: request.integrity,
                });
            } else {
                // For non-navigation requests, add both URL param and header
                modifiedRequest = new Request(modifiedUrl.href, {
                    headers: new Headers({
                        ...Object.fromEntries(request.headers),
                        'x-dappfence': 'processed',
                    }),
                    method: request.method,
                    mode: request.mode,
                    credentials: request.credentials,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy,
                    cache: request.cache,
                    integrity: request.integrity,
                    keepalive: request.keepalive,
                    signal: request.signal,
                    body: request.body,
                });
                logger.log(`[DFSW-HEADER+URL] Added header to: ${modifiedUrl.href}`);
            }

            // IMPORTANT: Replace the request in the event so ALL handlers see the modified version
            Object.defineProperty(event, 'request', {
                value: modifiedRequest,
                writable: false,
                configurable: false,
            });

            return modifiedRequest;
        } catch (error) {
            logger.warn(`Failed to modify request: ${request.url}`, error);
            return request; // Fallback to the original
        }
    }
    /**
     * Handle app service worker fetch event delegation
     */
    async function handleAppServiceWorkerFetch(event, callChildHandlers, request) {
        let appResponse = null;
        let appRespondedWith = false;

        // Store what the app's handler responds with
        const originalRespondWith = event.respondWith.bind(event);

        // Temporarily replace event.respondWith to intercept calls
        event.respondWith = function (responsePromise) {
            appRespondedWith = true;
            appResponse = responsePromise;
            // Don't actually call the original yet
        };

        // Let other handlers run with the REAL event object
        callChildHandlers(event);

        // Restore original respondWith
        event.respondWith = originalRespondWith;

        // Check if any handler called respondWith
        if (!appRespondedWith) {
            logger.log('No handler responded, fetching directly:', request.url);
            return await swContext.fetch(request);
        }

        try {
            return await appResponse;
        } catch (error) {
            logger.warn('App handler promise rejected, falling back to fetch:', error);
        }
        return await swContext.fetch(request);
    }

    /**
     * Run the manifest-aware verification for an asset response. `verifyFile`
     * decides whether to actually verify (returns SKIPPED for non-applicable
     * assets) or hashes and compares. Only true violations reach
     * recordSecurityViolation; SKIPPED and MATCH pass through.
     */
    async function verifyAssetIntegrity(ctx, request, response, clientId) {
        logger.log('Verifying security-critical asset:', request.url);

        // Clone so the original body is still available to forward to the page;
        // verifyFile consumes the clone via arrayBuffer().
        const verificationResult = await ctx.verifyFile(request, response.clone(), clientId);
        if (verificationResult.status.isViolation) {
            return await appStore.recordSecurityViolation({
                ...verificationResult,
                assetType: ASSET_TYPE.ASSET,
                url: request.url,
            });
        }
        return false;
    }

    return async (event, callChildHandlers) => {
        const originalRequest = event.request;
        try {
            const url = new URL(originalRequest.url);
            const clientId =
                originalRequest.mode === 'navigate' ? event.resultingClientId : event.clientId;

            // Log all fetch requests for debugging
            logger.log(
                `%cFetch: ${originalRequest.method} ${originalRequest.url} mode: ${originalRequest.mode} clientId: ${clientId} `,
                'color:cyan'
            );

            // Handle internal API endpoints. Served in every mode so client-side
            // dappfence.js can always talk to the SW. If the handler declines
            // (undefined), fall through to the normal child-SW pipeline — API
            // probes behave like any other asset request and don't reveal
            // DappFence via the warning redirect.
            if (url.pathname.startsWith(API_PREFIX)) {
                logger.log('Handling API endpoint:', url.pathname);
                const response = await handleApiEndpoint(url.pathname, originalRequest);
                if (response) {
                    return response;
                }
            }

            // share the single IndexedDB lookup done here.
            // Resolve the manifest context once per request — mode and verifyFile
            const ctx = await manifestService.resolveManifest();
            logger.log(`Client mode: ${clientId} ${ctx.mode}`);

            // Site-wide block gate only fires in protected mode. In other modes we
            // still let the request flow so the child SW's response is returned
            // untouched.
            if (ctx.mode === MODE.PROTECTED && (await activeBlocksStore.isBlocked())) {
                return createBlockResponse(originalRequest, locationHref);
            }

            // Add tracking markers to request BEFORE any handlers to see it
            const markedRequest = isFeatureEnabled('mark_request')
                ? addMarkToRequest(event, originalRequest)
                : originalRequest;

            // Delegate to child SW and capture its response
            const response = await handleAppServiceWorkerFetch(
                event,
                callChildHandlers,
                markedRequest
            );
            if (!response || !response.ok) {
                return response;
            }

            const mustBlock = await verifyAssetIntegrity(ctx, markedRequest, response, clientId);
            if (ctx.mode === MODE.PROTECTED && mustBlock) {
                // Navigation requests get the warning inline via createBlockResponse;
                // so broadcasting to the client would double-notify.
                if (markedRequest.mode !== 'navigate') {
                    await onSecurityViolation();
                }
                return createBlockResponse(markedRequest, locationHref);
            }
            return response;
        } catch (error) {
            logger.error('Error processing:', originalRequest.url, error);
        }
        // On error, fallback to regular fetch to avoid breaking the app
        try {
            return await swContext.fetch(originalRequest);
        } catch (fetchError) {
            logger.error('Fallback fetch also failed:', originalRequest.url, fetchError);
        }
        // Return undefined to let the browser handle the error
        return undefined;
    };
}
