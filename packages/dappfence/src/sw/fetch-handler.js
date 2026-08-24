/**
 * Security Fetch Handler Module
 * Orchestrates security checks and app service worker integration
 */

import { createBlockResponse, createRewriteResponse } from './response.js';
import { createLogger } from '../core/logger.js';
import { API_PREFIX, MODE, VERIFICATION_STATUS } from '../core/constants.js';

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
    const locationHref = swContext.getLocationHref();

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

    async function applyIntegrityPolicy(ctx, request, response, clientId) {
        logger.log('Verifying security-critical asset:', request.url);
        const verificationResult = await ctx.verifyResponse(request, response, clientId);
        let mustBlock = false;
        if (
            verificationResult.status !== VERIFICATION_STATUS.MATCH &&
            verificationResult.status !== VERIFICATION_STATUS.SKIPPED
        ) {
            mustBlock = await appStore.recordSecurityViolation({
                ...verificationResult,
                url: request.url,
                httpStatus: response.status,
            });
        }

        if (verificationResult.status === VERIFICATION_STATUS.REWRITE) {
            return createRewriteResponse(response);
        }
        if (ctx.mode === MODE.PROTECTED && mustBlock) {
            // Navigation requests get the warning inline via createBlockResponse;
            // so broadcasting to the client would double-notify.
            if (request.mode !== 'navigate') {
                await onSecurityViolation();
            }
            return createBlockResponse(request, locationHref);
        }
        return response;
    }

    async function handleRequest(event, callChildHandlers) {
        const request = event.request;
        const url = new URL(request.url);
        const clientId = request.mode === 'navigate' ? event.resultingClientId : event.clientId;

        logger.log(
            `%cRequest: ${request.url} method:${request.method} mode:${request.mode} destination:${request.destination === '' ? 'empty' : request.destination} clientId:${clientId} credentials:${request.credentials}`,
            'color:cyan'
        );

        // Handle internal API endpoints. Served in every mode so client-side
        // dappfence.js can always talk to the SW. If the handler declines
        // (undefined), fall through to the normal child-SW pipeline — API
        // probes behave like any other asset request and don't reveal
        // DappFence via the warning redirect.
        if (url.pathname.startsWith(API_PREFIX)) {
            logger.log('Handling API endpoint:', url.pathname);
            const response = await handleApiEndpoint(url.pathname, request);
            if (response) {
                return response;
            }
        }

        // Resolve the manifest context once per request — mode and verifyResponse
        // share the single IndexedDB lookup done here.
        const ctx = await manifestService.resolveManifest();
        logger.log(`Client mode: ${clientId} ${ctx.mode}`);

        // Site-wide block gate only fires in protected mode. In other modes we
        // still let the request flow so the child SW's response is returned
        // untouched.
        if (ctx.mode === MODE.PROTECTED && (await activeBlocksStore.isBlocked())) {
            return createBlockResponse(request, locationHref);
        }

        // Prepare request: upgrade no-cors executables to cors+omit and add
        // tracking markers (same-origin, when mark_request feature is enabled).
        // contentRules allow-by-destination checking before any CORS upgrade.
        const preparedRequest = ctx.prepareRequest(request);
        if (preparedRequest !== request) {
            // Replace event.request so ALL child handlers see the prepared version.
            Object.defineProperty(event, 'request', {
                value: preparedRequest,
                writable: false,
                configurable: false,
            });
        }

        // Try the child SW first; if its delegation or internal fetch fails,
        // fall back to a direct fetch so applyIntegrityPolicy still runs.
        let response;
        try {
            response = await handleAppServiceWorkerFetch(event, callChildHandlers, preparedRequest);
        } catch (error) {
            logger.warn('Child SW fetch failed, retrying direct:', request.url, error);
            response = await swContext.fetch(preparedRequest);
        }
        logger.log(
            `%cResponse ${request.url} ${response?.url} status:${response?.status} type:${response?.type ?? 'empty'} ${response?.redirected ? 'redirected' : ''}`,
            'color:cyan'
        );
        return await applyIntegrityPolicy(ctx, preparedRequest, response, clientId);
    }

    return async (event, callChildHandlers) => {
        try {
            return await handleRequest(event, callChildHandlers);
        } catch (error) {
            logger.error('Fatal error processing request:', event.request.url, error);
            // Rethrow fetch()-level errors (TypeError = network/CORS, AbortError = aborted)
            // so the browser sees the real failure
            if (
                error instanceof TypeError ||
                (error instanceof DOMException && error.name === 'AbortError')
            ) {
                throw error;
            }
            return new Response('Service unavailable', { status: 503 });
        }
    };
}
