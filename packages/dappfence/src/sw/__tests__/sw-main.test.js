import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('initializeServiceWorker', () => {
    let initializeServiceWorker;
    let createServices;
    let mockServices;

    beforeEach(async () => {
        vi.resetModules();
        globalThis.__FEATURES__ = {};
        if (typeof globalThis.self === 'undefined') {
            globalThis.self = globalThis;
        }
        vi.doMock('../services.js', () => ({
            createServices: vi.fn(() => {
                mockServices = {
                    hookService: {
                        installHooks: vi.fn(),
                        addEventListener: vi.fn(),
                        addDefaultEventListeners: vi.fn(),
                    },
                    fetchHandler: vi.fn(),
                    installHandler: vi.fn(),
                    activateHandler: vi.fn(),
                    messageHandler: vi.fn(),
                    syncHandler: vi.fn(),
                    securityProcessor: {
                        processSecurityEvent: vi.fn().mockResolvedValue(false),
                        reportOnFetch: vi.fn().mockResolvedValue(undefined),
                        reportOnInstall: vi.fn().mockResolvedValue(undefined),
                        reportOnClientRequest: vi.fn().mockResolvedValue(undefined),
                        reportOnPageLoad: vi.fn().mockResolvedValue(undefined),
                        reportOnSync: vi.fn().mockResolvedValue(undefined),
                    },
                };
                return mockServices;
            }),
        }));
        ({ initializeServiceWorker } = await import('../main.js'));
        ({ createServices } = await import('../services.js'));
    });

    it('calls hookService.installHooks once', () => {
        initializeServiceWorker();
        expect(mockServices.hookService.installHooks).toHaveBeenCalledTimes(1);
    });

    it('registers 5 event listeners via hookService.addEventListener', () => {
        initializeServiceWorker();
        expect(mockServices.hookService.addEventListener).toHaveBeenCalledTimes(5);
    });

    it('registers fetch, install, activate, message, sync event types', () => {
        initializeServiceWorker();
        const types = mockServices.hookService.addEventListener.mock.calls.map((c) => c[0]);
        expect(types).toContain('fetch');
        expect(types).toContain('install');
        expect(types).toContain('activate');
        expect(types).toContain('message');
        expect(types).toContain('sync');
    });

    it('calls hookService.addDefaultEventListeners once', () => {
        initializeServiceWorker();
        expect(mockServices.hookService.addDefaultEventListeners).toHaveBeenCalledTimes(1);
    });

    it('calls createServices', () => {
        initializeServiceWorker();
        expect(createServices).toHaveBeenCalledTimes(1);
    });

    it('sync listener wraps syncHandler in event.waitUntil', () => {
        initializeServiceWorker();
        const syncCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'sync'
        );
        const syncCallback = syncCall[1];
        const waitUntil = vi.fn();
        syncCallback({ waitUntil });
        expect(waitUntil).toHaveBeenCalled();
        expect(mockServices.syncHandler).toHaveBeenCalled();
    });

    it('message listener wraps messageHandler in event.waitUntil', () => {
        initializeServiceWorker();
        const messageCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'message'
        );
        const messageCallback = messageCall[1];
        const waitUntil = vi.fn();
        const callChildHandlers = vi.fn();
        messageCallback({ waitUntil }, callChildHandlers);
        expect(waitUntil).toHaveBeenCalled();
        expect(mockServices.messageHandler).toHaveBeenCalled();
    });

    it('fetch listener calls respondWith and schedules reportOnFetch after fetch settles', async () => {
        initializeServiceWorker();
        const fetchCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'fetch'
        );
        const fetchCallback = fetchCall[1];
        const respondWith = vi.fn();
        let reportWaiter;
        const waitUntil = vi.fn((p) => {
            reportWaiter = p;
        });
        mockServices.fetchHandler.mockResolvedValue(new Response('ok'));
        await fetchCallback({ respondWith, waitUntil }, vi.fn());
        await reportWaiter;
        expect(respondWith).toHaveBeenCalled();
        expect(waitUntil).toHaveBeenCalled();
        expect(mockServices.securityProcessor.reportOnFetch).toHaveBeenCalled();
    });

    it('install handler callback calls event.waitUntil with installHandler result', async () => {
        initializeServiceWorker();
        const installCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'install'
        );
        const installCallback = installCall[1];
        const waitUntil = vi.fn();
        mockServices.installHandler.mockResolvedValue(undefined);
        await installCallback({ waitUntil }, vi.fn());
        expect(waitUntil).toHaveBeenCalled();
    });

    it('activate handler callback calls event.waitUntil with activateHandler result', async () => {
        initializeServiceWorker();
        const activateCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'activate'
        );
        const activateCallback = activateCall[1];
        const waitUntil = vi.fn();
        mockServices.activateHandler.mockResolvedValue(undefined);
        await activateCallback({ waitUntil }, vi.fn());
        expect(waitUntil).toHaveBeenCalled();
    });
});
