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

    it('registers 4 event listeners via hookService.addEventListener', () => {
        initializeServiceWorker();
        expect(mockServices.hookService.addEventListener).toHaveBeenCalledTimes(4);
    });

    it('registers fetch, install, activate, message event types', () => {
        initializeServiceWorker();
        const types = mockServices.hookService.addEventListener.mock.calls.map((c) => c[0]);
        expect(types).toContain('fetch');
        expect(types).toContain('install');
        expect(types).toContain('activate');
        expect(types).toContain('message');
    });

    it('calls hookService.addDefaultEventListeners once', () => {
        initializeServiceWorker();
        expect(mockServices.hookService.addDefaultEventListeners).toHaveBeenCalledTimes(1);
    });

    it('calls createServices', () => {
        initializeServiceWorker();
        expect(createServices).toHaveBeenCalledTimes(1);
    });

    it('fetch handler callback calls event.respondWith with fetchHandler result', async () => {
        initializeServiceWorker();
        const fetchCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'fetch'
        );
        const fetchCallback = fetchCall[1];
        const respondWith = vi.fn();
        const callChildHandlers = vi.fn();
        mockServices.fetchHandler.mockResolvedValue(new Response('ok'));
        await fetchCallback({ respondWith }, callChildHandlers);
        expect(respondWith).toHaveBeenCalled();
    });

    it('install handler callback calls event.waitUntil with installHandler result', async () => {
        initializeServiceWorker();
        const installCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'install'
        );
        const installCallback = installCall[1];
        const waitUntil = vi.fn();
        const callChildHandlers = vi.fn();
        mockServices.installHandler.mockResolvedValue(undefined);
        await installCallback({ waitUntil }, callChildHandlers);
        expect(waitUntil).toHaveBeenCalled();
    });

    it('activate handler callback calls event.waitUntil with activateHandler result', async () => {
        initializeServiceWorker();
        const activateCall = mockServices.hookService.addEventListener.mock.calls.find(
            (c) => c[0] === 'activate'
        );
        const activateCallback = activateCall[1];
        const waitUntil = vi.fn();
        const callChildHandlers = vi.fn();
        mockServices.activateHandler.mockResolvedValue(undefined);
        await activateCallback({ waitUntil }, callChildHandlers);
        expect(waitUntil).toHaveBeenCalled();
    });
});
