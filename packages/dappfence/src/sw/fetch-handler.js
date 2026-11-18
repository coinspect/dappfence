/**
 * Security Fetch Handler Module
 * Orchestrates security checks and app service worker integration
 */

import {
    createBlockResponse,
    createRedirectResponse,
    createRewriteResponse,
    injectResponseHeaders,
} from './response.js';
import { createLogger } from '../core/logger.js';
import { API_PREFIX, MODE, VERIFICATION_STATUS } from '../core/constants.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext - Service worker context wrapper
 * @param {object} deps.manifestService - Manifest verification service
 * @param {function} deps.onSecurityViolation - Called to broadcast the block condition
 * @param {object} deps.appStore - App store facade
 * @param {object} deps.securityProcessor - Security event orchestrator
 * @param {function} deps.handleApiEndpoint - Internal /sw-api/* request handler
 * @returns {function} Fetch event handler (event, callChildHandlers) => Promise<Response>
 */
export function createSecurityFetchHandler({
    swContext,
    manifestService,
    onSecurityViolation,
    appStore,
    securityProcessor,
    handleApiEndpoint,
}) {
    const { securityStore } = appStore;
    const locationHref = swContext.getLocationHref();

    /**
     * Fetch the response for a request: prefer the app SW's installed handler;
     * fall back to a direct fetch when no handler responds, when the app
     * handler's promise rejects, or when a child handler throws synchronously.
     * The returned WrappedResponse carries lazy, capped body-read methods;
     * callers that need the native Response (e.g. `event.respondWith`) call
     * `.toResponse()`.
     */
    async function handleAppServiceWorkerFetch(event, callChildHandlers, request) {
        try {
            let appResponse = null;
            let appRespondedWith = false;
            const originalRespondWith = event.respondWith.bind(event);
            event.respondWith = function (responsePromise) {
                appRespondedWith = true;
                appResponse = responsePromise;
            };
            callChildHandlers(event);
            event.respondWith = originalRespondWith;

            if (!appRespondedWith) {
                logger.log('No handler responded, fetching directly:', request.url);
                return swContext.fetchWrapped(request);
            }
            try {
                return swContext.wrapResponse(await appResponse);
            } catch (error) {
                logger.warn('App handler promise rejected, falling back to fetch:', error);
            }
            // appResponse rejected; direct fetch fallback (fetch returns wrapped).
            return swContext.fetchWrapped(request);
        } catch (error) {
            logger.warn('Child SW handler threw, retrying direct:', request.url, error);
            return swContext.fetchWrapped(request);
        }
    }

    async function applyIntegrityPolicy(ctx, request, response, clientId) {
        logger.log('Verifying security-critical asset:', request.url);
        const verificationResult = await ctx.verifyResponse(request, response, clientId);
        const mustBlock = await securityProcessor.processSecurityEvent({
            ...verificationResult,
            url: request.url,
            httpStatus: response.status,
        });

        if (verificationResult.status === VERIFICATION_STATUS.REWRITE) {
            return createRewriteResponse(response.unwrap());
        }
        if (verificationResult.status === VERIFICATION_STATUS.REDIRECT) {
            return createRedirectResponse(
                verificationResult.location,
                verificationResult.httpStatus
            );
        }
        if (ctx.mode === MODE.PROTECTED && mustBlock) {
            // Navigation requests get the warning inline via createBlockResponse;
            // so broadcasting to the client would double-notify.
            if (request.mode !== 'navigate') {
                await onSecurityViolation();
            }
            return createBlockResponse(request, locationHref);
        }
        if (verificationResult.headers) {
            return injectResponseHeaders(response.unwrap(), verificationResult.headers);
        }
        return response.unwrap();
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
        if (ctx.mode === MODE.PROTECTED && (await securityStore.isBlocked())) {
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

        // handleAppServiceWorkerFetch owns its own fetch + fallback flow; it
        // returns a WrappedResponse so body reads downstream are capped.
        const wrappedResponse = await handleAppServiceWorkerFetch(
            event,
            callChildHandlers,
            preparedRequest
        );
        logger.log(
            `%cResponse ${request.url} ${wrappedResponse?.url} status:${wrappedResponse?.status} type:${wrappedResponse?.type ?? 'empty'} ${wrappedResponse?.redirected ? 'redirected' : ''}`,
            'color:cyan'
        );
        return await applyIntegrityPolicy(ctx, preparedRequest, wrappedResponse, clientId);
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
