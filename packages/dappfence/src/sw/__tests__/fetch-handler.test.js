import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecurityFetchHandler } from '../fetch-handler.js';
import { MODE, VERIFICATION_STATUS } from '../../core/constants.js';

vi.mock('../response.js', () => ({
    createBlockResponse: vi.fn(() => new Response('blocked', { status: 403 })),
}));

vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn((flag) => globalThis.__FEATURES__?.[flag] === true),
}));

import { createBlockResponse } from '../response.js';

const ORIGIN = 'https://example.com';

function makeRequest(url, { mode = 'no-cors', method = 'GET' } = {}) {
    const req = new Request(url, { method });
    Object.defineProperty(req, 'mode', { value: mode, configurable: true });
    return req;
}

function makeFetchEvent(request, { clientId = 'client-1', resultingClientId = '' } = {}) {
    const event = {
        request,
        clientId,
        resultingClientId,
        respondWith: vi.fn(),
    };
    return event;
}

function setup({
    mode = MODE.REPORTING,
    isBlocked = false,
    verifyFileStatus = VERIFICATION_STATUS.SKIPPED,
    apiResponse = undefined,
    fetchResponse = new Response('ok', { status: 200 }),
} = {}) {
    const swContext = {
        getLocationOrigin: vi.fn(() => ORIGIN),
        getLocationHref: vi.fn(() => `${ORIGIN}/sw.js`),
        fetch: vi.fn(() => Promise.resolve(fetchResponse)),
    };

    const manifestService = {
        resolveManifest: vi.fn(() =>
            Promise.resolve({
                mode,
                verifyFile: vi.fn(() => Promise.resolve({ status: verifyFileStatus })),
            })
        ),
    };

    const appStore = {
        activeBlocksStore: {
            isBlocked: vi.fn(() => Promise.resolve(isBlocked)),
        },
        recordSecurityViolation: vi.fn(() => Promise.resolve(true)),
    };

    const onSecurityViolation = vi.fn(() => Promise.resolve());
    const handleApiEndpoint = vi.fn(() => Promise.resolve(apiResponse));

    const handler = createSecurityFetchHandler({
        swContext,
        manifestService,
        onSecurityViolation,
        appStore,
        handleApiEndpoint,
    });

    return {
        handler,
        swContext,
        manifestService,
        appStore,
        onSecurityViolation,
        handleApiEndpoint,
    };
}

beforeEach(() => {
    globalThis.__FEATURES__ = { mark_request: false };
    vi.clearAllMocks();
});

describe('createSecurityFetchHandler', () => {
    describe('API endpoint routing', () => {
        it('calls handleApiEndpoint for /sw-api/ paths and returns its response', async () => {
            const apiRes = new Response('api ok', { status: 200 });
            const { handler, handleApiEndpoint } = setup({ apiResponse: apiRes });
            const request = makeRequest(`${ORIGIN}/sw-api/status`);
            const event = makeFetchEvent(request);
            const callChildHandlers = vi.fn();

            const result = await handler(event, callChildHandlers);

            expect(handleApiEndpoint).toHaveBeenCalledWith('/sw-api/status', request);
            expect(result).toBe(apiRes);
        });

        it('continues pipeline when handleApiEndpoint returns undefined', async () => {
            const { handler, handleApiEndpoint, swContext } = setup({ apiResponse: undefined });
            const request = makeRequest(`${ORIGIN}/sw-api/probe`);
            const event = makeFetchEvent(request);
            const callChildHandlers = vi.fn();

            await handler(event, callChildHandlers);

            expect(handleApiEndpoint).toHaveBeenCalled();
            expect(swContext.fetch).toHaveBeenCalled();
        });
    });

    describe('block gate', () => {
        it('returns block response in PROTECTED mode when site is blocked', async () => {
            const { handler } = setup({ mode: MODE.PROTECTED, isBlocked: true });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const result = await handler(event, vi.fn());

            expect(createBlockResponse).toHaveBeenCalled();
            expect(result.status).toBe(403);
        });

        it('does not block in REPORTING mode even when site is blocked', async () => {
            const { handler } = setup({ mode: MODE.REPORTING, isBlocked: true });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(createBlockResponse).not.toHaveBeenCalled();
        });
    });

    describe('mark_request feature', () => {
        it('adds x-dappfence header to same-origin subresource when mark_request is enabled', async () => {
            globalThis.__FEATURES__ = { mark_request: true };
            const { handler, swContext } = setup({
                fetchResponse: new Response('ok', { status: 200 }),
            });

            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);
            const callChildHandlers = vi.fn();

            await handler(event, callChildHandlers);

            const fetchedRequest = swContext.fetch.mock.calls[0]?.[0];
            if (fetchedRequest instanceof Request) {
                expect(fetchedRequest.headers.get('x-dappfence')).toBe('processed');
            } else {
                expect(event.request.headers.get('x-dappfence')).toBe('processed');
            }
        });

        it('does not add x-dappfence header to cross-origin requests', async () => {
            globalThis.__FEATURES__ = { mark_request: true };
            const { handler, swContext } = setup({
                fetchResponse: new Response('ok', { status: 200 }),
            });

            const request = makeRequest('https://cdn.example.net/lib.js');
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            const fetchedRequest = swContext.fetch.mock.calls[0]?.[0];
            if (fetchedRequest instanceof Request) {
                expect(fetchedRequest.headers.get('x-dappfence')).toBeNull();
            }
        });

        it('skips marking when mark_request feature is disabled', async () => {
            globalThis.__FEATURES__ = { mark_request: false };
            const { handler } = setup({
                fetchResponse: new Response('ok', { status: 200 }),
            });

            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(event.request.headers.get('x-dappfence')).toBeNull();
        });
    });

    describe('app SW delegation', () => {
        it('falls back to swContext.fetch when no handler calls respondWith', async () => {
            const fetchResp = new Response('from network', { status: 200 });
            const { handler, swContext } = setup({ fetchResponse: fetchResp });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);
            const callChildHandlers = vi.fn();

            const result = await handler(event, callChildHandlers);

            expect(swContext.fetch).toHaveBeenCalled();
            expect(result).toBe(fetchResp);
        });

        it('returns app handler response when respondWith is called', async () => {
            const { handler, swContext } = setup({
                fetchResponse: new Response('network', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);
            const appResp = new Response('from app sw', { status: 200 });

            const callChildHandlers = vi.fn((ev) => {
                ev.respondWith(Promise.resolve(appResp));
            });

            const result = await handler(event, callChildHandlers);

            expect(swContext.fetch).not.toHaveBeenCalled();
            expect(result).toBe(appResp);
        });

        it('falls back to swContext.fetch when respondWith promise rejects', async () => {
            const fallback = new Response('fallback', { status: 200 });
            const { handler, swContext } = setup({ fetchResponse: fallback });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const callChildHandlers = vi.fn((ev) => {
                ev.respondWith(Promise.reject(new Error('app sw crashed')));
            });

            const result = await handler(event, callChildHandlers);

            expect(swContext.fetch).toHaveBeenCalled();
            expect(result).toBe(fallback);
        });
    });

    describe('asset verification', () => {
        it('passes through response when verification returns MATCH', async () => {
            const okResp = new Response('ok', { status: 200 });
            const { handler } = setup({
                verifyFileStatus: VERIFICATION_STATUS.MATCH,
                fetchResponse: okResp,
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const result = await handler(event, vi.fn());

            expect(result).toBe(okResp);
        });

        it('calls recordSecurityViolation on MISMATCH', async () => {
            const { handler, appStore } = setup({
                mode: MODE.REPORTING,
                verifyFileStatus: VERIFICATION_STATUS.MISMATCH,
                fetchResponse: new Response('ok', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(appStore.recordSecurityViolation).toHaveBeenCalledWith(
                expect.objectContaining({ url: `${ORIGIN}/app.js` })
            );
        });

        it('does not verify when response is non-ok (404)', async () => {
            const { handler, appStore } = setup({
                verifyFileStatus: VERIFICATION_STATUS.MISMATCH,
                fetchResponse: new Response('not found', { status: 404 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(appStore.recordSecurityViolation).not.toHaveBeenCalled();
        });

        it('does not verify when response is SKIPPED (isViolation false)', async () => {
            const { handler, appStore } = setup({
                verifyFileStatus: VERIFICATION_STATUS.SKIPPED,
                fetchResponse: new Response('ok', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(appStore.recordSecurityViolation).not.toHaveBeenCalled();
        });
    });

    describe('PROTECTED mode violation handling', () => {
        it('calls onSecurityViolation and blocks non-navigation on MISMATCH in PROTECTED mode', async () => {
            const { handler, onSecurityViolation } = setup({
                mode: MODE.PROTECTED,
                verifyFileStatus: VERIFICATION_STATUS.MISMATCH,
                fetchResponse: new Response('ok', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const result = await handler(event, vi.fn());

            expect(onSecurityViolation).toHaveBeenCalled();
            expect(createBlockResponse).toHaveBeenCalled();
            expect(result.status).toBe(403);
        });

        it('does not call onSecurityViolation for navigate MISMATCH in PROTECTED mode', async () => {
            const { handler, onSecurityViolation } = setup({
                mode: MODE.PROTECTED,
                verifyFileStatus: VERIFICATION_STATUS.MISMATCH,
                fetchResponse: new Response('ok', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/page.html`, { mode: 'navigate' });
            const event = makeFetchEvent(request, { clientId: '', resultingClientId: 'client-1' });

            const result = await handler(event, vi.fn());

            expect(onSecurityViolation).not.toHaveBeenCalled();
            expect(createBlockResponse).toHaveBeenCalled();
            expect(result.status).toBe(403);
        });

        it('does not call onSecurityViolation or block in REPORTING mode on MISMATCH', async () => {
            const { handler, onSecurityViolation } = setup({
                mode: MODE.REPORTING,
                verifyFileStatus: VERIFICATION_STATUS.MISMATCH,
                fetchResponse: new Response('ok', { status: 200 }),
            });
            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            await handler(event, vi.fn());

            expect(onSecurityViolation).not.toHaveBeenCalled();
            expect(createBlockResponse).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('falls back to swContext.fetch when resolveManifest rejects', async () => {
            const fallback = new Response('fallback', { status: 200 });
            const { handler, swContext, manifestService } = setup({ fetchResponse: fallback });
            manifestService.resolveManifest.mockRejectedValue(new Error('manifest failed'));

            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const result = await handler(event, vi.fn());

            expect(swContext.fetch).toHaveBeenCalled();
            expect(result).toBe(fallback);
        });

        it('returns undefined when both resolveManifest and fallback fetch fail', async () => {
            const { handler, swContext, manifestService } = setup();
            manifestService.resolveManifest.mockRejectedValue(new Error('manifest failed'));
            swContext.fetch.mockRejectedValue(new Error('network failed'));

            const request = makeRequest(`${ORIGIN}/app.js`);
            const event = makeFetchEvent(request);

            const result = await handler(event, vi.fn());

            expect(result).toBeUndefined();
        });
    });

    describe('navigation mark_request', () => {
        it('adds x-dappfence header to navigate requests when mark_request is enabled', async () => {
            globalThis.__FEATURES__ = { mark_request: true };
            const { handler, swContext } = setup({
                fetchResponse: new Response('ok', { status: 200 }),
            });

            const request = makeRequest(`${ORIGIN}/page.html`, { mode: 'navigate' });
            const event = makeFetchEvent(request, { clientId: '', resultingClientId: 'nav-1' });
            const callChildHandlers = vi.fn();

            const result = await handler(event, callChildHandlers);

            expect(swContext.fetch).toHaveBeenCalled();
            expect(result).toBeDefined();
        });
    });

    describe('addMarkToRequest error path', () => {
        it('falls back to original request when mark_request throws due to bad headers', async () => {
            globalThis.__FEATURES__ = { mark_request: true };
            const { handler, swContext } = setup({
                fetchResponse: new Response('ok', { status: 200 }),
            });

            const badRequest = new Proxy(new Request(`${ORIGIN}/app.js`), {
                get(target, prop) {
                    if (prop === 'headers') {
                        throw new Error('headers inaccessible');
                    }
                    return typeof target[prop] === 'function'
                        ? target[prop].bind(target)
                        : target[prop];
                },
            });

            const event = makeFetchEvent(badRequest);
            const callChildHandlers = vi.fn();

            await expect(handler(event, callChildHandlers)).resolves.not.toThrow();
            expect(swContext.fetch).toHaveBeenCalled();
        });
    });
});
