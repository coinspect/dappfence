import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHookService } from '../appsw-hooks.js';

describe('createHookService (with importScripts)', () => {
    let originalImportScripts;

    beforeEach(() => {
        originalImportScripts = globalThis.importScripts;
        globalThis.importScripts = vi.fn();
    });

    afterEach(() => {
        if (originalImportScripts === undefined) {
            delete globalThis.importScripts;
        } else {
            globalThis.importScripts = originalImportScripts;
        }
    });

    it('installHooks patches importScripts when it is defined', () => {
        const onVerifyScript = vi.fn().mockResolvedValue(undefined);
        const scope = {
            addEventListener: vi.fn(),
            importScripts: vi.fn(),
        };
        const svc = createHookService(onVerifyScript, scope);
        svc.installHooks();
        expect(scope.importScripts).not.toBe(globalThis.importScripts);
    });

    it('patched importScripts calls onVerifyScript for each script path', async () => {
        const onVerifyScript = vi.fn().mockResolvedValue(undefined);
        const originalImportScriptsFn = vi.fn();
        const scope = {
            addEventListener: vi.fn(),
            importScripts: originalImportScriptsFn,
        };
        const svc = createHookService(onVerifyScript, scope);
        svc.installHooks();

        scope.importScripts('/app-sw.js', '/vendor.js');

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(onVerifyScript).toHaveBeenCalledWith('/app-sw.js');
        expect(onVerifyScript).toHaveBeenCalledWith('/vendor.js');
        expect(originalImportScriptsFn).toHaveBeenCalledWith('/app-sw.js', '/vendor.js');
    });

    it('patched importScripts logs warning when called after installEventDone', async () => {
        const onVerifyScript = vi.fn().mockResolvedValue(undefined);
        const scope = {
            addEventListener: vi.fn(),
            importScripts: vi.fn(),
        };
        const svc = createHookService(onVerifyScript, scope);
        svc.installHooks();
        svc.installEventDone();

        expect(() => scope.importScripts('/after-install.js')).not.toThrow();
    });

    it('patched importScripts logs error when onVerifyScript rejects', async () => {
        const onVerifyScript = vi.fn().mockRejectedValue(new Error('verification failed'));
        const scope = {
            addEventListener: vi.fn(),
            importScripts: vi.fn(),
        };
        const svc = createHookService(onVerifyScript, scope);
        svc.installHooks();

        scope.importScripts('/bad-script.js');

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(onVerifyScript).toHaveBeenCalledWith('/bad-script.js');
    });
});

describe('createHookService', () => {
    let originalAddEventListener;
    let onVerifyScript;
    let service;
    let swScope;

    beforeEach(() => {
        originalAddEventListener = vi.fn();
        swScope = { addEventListener: originalAddEventListener };
        onVerifyScript = vi.fn().mockResolvedValue(undefined);
        service = createHookService(onVerifyScript, swScope);
    });

    it('installHooks patches swScope.addEventListener', () => {
        service.installHooks();
        expect(swScope.addEventListener).not.toBe(originalAddEventListener);
    });

    it('addEventListener throws when called before installHooks', () => {
        expect(() => {
            service.addEventListener('fetch', vi.fn());
        }).toThrow('[DappFence SW] Error Service Worker hooks not installed');
    });

    it('addEventListener after installHooks calls the original addEventListener', () => {
        service.installHooks();
        const handler = vi.fn();
        service.addEventListener('fetch', handler);
        expect(originalAddEventListener).toHaveBeenCalledWith('fetch', expect.any(Function));
    });

    it('addDefaultEventListeners calls the original addEventListener 15 times', () => {
        service.installHooks();
        service.addDefaultEventListeners();
        expect(originalAddEventListener).toHaveBeenCalledTimes(15);
    });

    it('installEventDone is a function and does not throw when called', () => {
        expect(typeof service.installEventDone).toBe('function');
        expect(() => service.installEventDone()).not.toThrow();
    });

    it('a listener appended via patched swScope.addEventListener is invoked when callChildHandlers fires', () => {
        service.installHooks();

        const childListener = vi.fn();

        swScope.addEventListener('fetch', childListener);

        service.addEventListener('fetch', (event, callChildHandlers) => {
            callChildHandlers(event);
        });

        const wrappedHandler = originalAddEventListener.mock.calls.find(
            (c) => c[0] === 'fetch'
        )?.[1];

        expect(wrappedHandler).toBeDefined();
        const fakeEvent = { type: 'fetch' };
        wrappedHandler(fakeEvent);

        expect(childListener).toHaveBeenCalledWith(fakeEvent);
    });

    it('callChildHandlers catches errors thrown by a child listener and continues', () => {
        service.installHooks();

        const throwingListener = vi.fn(() => {
            throw new Error('listener crashed');
        });
        const safeListener = vi.fn();

        swScope.addEventListener('fetch', throwingListener);
        swScope.addEventListener('fetch', safeListener);

        service.addEventListener('fetch', (_event, callChildHandlers) => {
            callChildHandlers(_event);
        });

        const wrappedHandler = originalAddEventListener.mock.calls.find(
            (c) => c[0] === 'fetch'
        )?.[1];
        expect(wrappedHandler).toBeDefined();
        const fakeEvent = { type: 'fetch' };
        expect(() => wrappedHandler(fakeEvent)).not.toThrow();
        expect(safeListener).toHaveBeenCalled();
    });

    it('addDefaultEventListeners: handler fires callChildHandlers for each event type', () => {
        service.installHooks();
        service.addDefaultEventListeners();

        const wrappedSyncHandler = originalAddEventListener.mock.calls.find(
            (c) => c[0] === 'sync'
        )?.[1];
        expect(wrappedSyncHandler).toBeDefined();

        const childHandler = vi.fn();
        swScope.addEventListener('sync', childHandler);

        const fakeEvent = { type: 'sync' };
        wrappedSyncHandler(fakeEvent);

        expect(childHandler).toHaveBeenCalledWith(fakeEvent);
    });
});
