/**
 * Service Worker API Handler Module
 * Handles internal API endpoints for trusted manifest control
 */
import { createLogger } from '../core/logger.js';
import { createRedirectResponse, createSecurityPageResponse } from './response.js';
import { API } from '../core/constants.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {function} deps.onSecurityViolation - called to broadcast the active block condition
 * @param {object} deps.appStore
 */
export function createApiHandler({ onSecurityViolation, appStore }) {
    const {
        apiTokenStore,
        activeBlocksStore,
        trustedManifestStore,
        verificationResultsStore,
        cspViolationsStore,
    } = appStore;

    async function validateApiToken(request) {
        const token = await apiTokenStore.getApiToken();
        const providedToken =
            request.headers.get('X-DappFence-Token') ||
            new URL(request.url).searchParams.get('token');
        return providedToken === token;
    }

    async function handleStatus(_request) {
        logger.log('Serving status endpoint');
        const latest = await trustedManifestStore.getLatest();
        const appVersion = latest?.appVersion ?? null;
        const trustedManifest = latest?.manifest;
        const verificationResults = appVersion
            ? await verificationResultsStore.get(appVersion)
            : [];
        const [blockHistory, cspViolations] = await Promise.all([
            activeBlocksStore.getAllBlocks(),
            cspViolationsStore.getViolations(),
        ]);
        const status = {
            appVersion,
            timestamp: new Date().toISOString(),
            trustedManifest,
            verificationResults,
            blockHistory,
            cspViolations,
            stats: {
                trustedFiles: Object.keys(trustedManifest?.files ?? {}).length,
                totalVerifications: verificationResults.length,
                totalBlocks: blockHistory.length,
                activeBlocks: blockHistory.filter((b) => b.active).length,
                totalCspViolations: cspViolations.length,
            },
        };
        logger.log('Status report:', JSON.stringify(status.stats));
        return new Response(JSON.stringify(status, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    async function handleSecurityWarning(request) {
        // Only respond to real navigations (top-level redirects, meta-refresh, link
        // clicks, 302 follow-ups). JavaScript `fetch()` cannot forge Sec-Fetch-Mode
        // / request.mode === 'navigate', so probing via fetch falls through to the
        // network and gets a normal 404 — the endpoint appears not to exist.
        if (request.mode !== 'navigate') {
            logger.log('security-warning: non-navigation access, falling through');
            return;
        }
        if (!(await activeBlocksStore.isBlocked())) {
            logger.log('fetch api No active block - redirecting home');
            return createRedirectResponse('/');
        }
        logger.log(`fetch api Broadcasting active block condition`);
        await onSecurityViolation();
        const [apiToken, activeBlocks] = await Promise.all([
            apiTokenStore.getApiToken(),
            activeBlocksStore.getActiveBlocks(),
        ]);
        return createSecurityPageResponse(apiToken, activeBlocks);
    }

    async function handleCspViolation(request) {
        const contentType = request.headers.get('Content-Type') ?? '';
        if (
            !contentType.includes('application/csp-report') &&
            !contentType.includes('application/reports+json')
        ) {
            return new Response('Unsupported Media Type', { status: 415 });
        }
        const body = await request.text();
        if (body.length > 4096) {
            return new Response('Payload Too Large', { status: 413 });
        }
        let report;
        try {
            report = JSON.parse(body);
        } catch {
            return new Response('Bad Request', { status: 400 });
        }
        logger.warn('[CSP] violation report:', JSON.stringify(report));
        await cspViolationsStore.logViolation(report);
        return new Response(null, { status: 204 });
    }

    async function handleSiteUnblock(_request) {
        // Errors bubble to the outer catch and become a plain-text 500, matching
        // how the rest of this handler reports unexpected failures.
        await activeBlocksStore.clearBlockCondition();
        logger.log('Site unblocked successfully');
        return new Response(
            JSON.stringify({
                success: true,
                message: 'Site has been unblocked',
                timestamp: Date.now(),
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        );
    }

    // Dispatch table: method → path → { handler, public? }.
    // Routes are private by default; public endpoints must opt in with `public: true`
    // so adding a new endpoint without thinking about access fails safe.
    const ROUTES = {
        GET: {
            [API.STATUS]: { public: true, handler: handleStatus },
            [API.SECURITY_WARNING]: { public: true, handler: handleSecurityWarning },
        },
        POST: {
            [API.SITE_UNBLOCK]: { handler: handleSiteUnblock },
            [API.CSP_VIOLATION]: { handler: handleCspViolation },
        },
    };

    return async function handleApiEndpoint(pathname, request) {
        try {
            // Unknown endpoint or bad token → return undefined so the fetch handler
            // forwards to the network. The attacker sees a normal server 404,
            // indistinguishable from a site without DappFence.
            const route = ROUTES[request.method]?.[pathname];
            const allowed = route && (route.public || (await validateApiToken(request)));
            if (allowed) {
                return await route.handler(request);
            }
        } catch (error) {
            logger.error('API endpoint error:', error);
            return new Response('Internal server error', {
                status: 500,
                headers: { 'Content-Type': 'text/plain' },
            });
        }
    };
}
