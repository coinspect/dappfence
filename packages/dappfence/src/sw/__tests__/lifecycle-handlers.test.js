import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstallHandler, createActivateHandler } from '../lifecycle-handlers.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

beforeEach(() => {
    globalThis.importScripts = vi.fn();
});

afterEach(() => {
    delete globalThis.importScripts;
});

function makeInstallDeps({
    skipWaiting = vi.fn(() => Promise.resolve()),
    appSW = null,
    manifestUrl = 'https://example.com/manifest.json',
    fetchAndStoreManifestResult = {
        status: VERIFICATION_STATUS.MATCH,
        appVersion: 'v1',
        manifest: { mode: 'reporting' },
    },
    onInstallDone = vi.fn(),
    recordSecurityViolation = vi.fn(() => Promise.resolve()),
} = {}) {
    return {
        swContext: { skipWaiting },
        config: { appSW, manifestUrl },
        manifestService: {
            fetchAndStoreManifest: vi.fn(() => Promise.resolve(fetchAndStoreManifestResult)),
        },
        onInstallDone,
        appStore: {
            recordSecurityViolation,
        },
    };
}

function makeActivateDeps({
    claimClients = vi.fn(() => Promise.resolve()),
    onSecurityViolation = vi.fn(() => Promise.resolve()),
    isBlocked = false,
} = {}) {
    return {
        swContext: { claimClients },
        onSecurityViolation,
        appStore: {
            activeBlocksStore: {
                isBlocked: vi.fn(() => Promise.resolve(isBlocked)),
            },
        },
    };
}

describe('createInstallHandler', () => {
    it('calls skipWaiting', async () => {
        const deps = makeInstallDeps();
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.swContext.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it('calls fetchAndStoreManifest', async () => {
        const deps = makeInstallDeps();
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.manifestService.fetchAndStoreManifest).toHaveBeenCalledTimes(1);
    });

    it('records security violation when manifest verification fails', async () => {
        const manifestUrl = 'https://example.com/manifest.json';
        const deps = makeInstallDeps({
            manifestUrl,
            fetchAndStoreManifestResult: { status: VERIFICATION_STATUS.MISMATCH, url: manifestUrl },
        });
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({ url: manifestUrl })
        );
    });

    it('does not record security violation on manifest success', async () => {
        const deps = makeInstallDeps({
            fetchAndStoreManifestResult: {
                status: VERIFICATION_STATUS.MATCH,
                appVersion: 'v1',
                manifest: { mode: 'reporting' },
            },
        });
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('calls importScripts when config.appSW is set', async () => {
        const deps = makeInstallDeps({ appSW: 'https://example.com/app-sw.js' });
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(globalThis.importScripts).toHaveBeenCalledWith('https://example.com/app-sw.js');
    });

    it('does not call importScripts when config.appSW is not set', async () => {
        const deps = makeInstallDeps({ appSW: null });
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(globalThis.importScripts).not.toHaveBeenCalled();
    });

    it('still resolves without throwing when importScripts throws', async () => {
        globalThis.importScripts = vi.fn(() => {
            throw new Error('importScripts failed');
        });
        const deps = makeInstallDeps({ appSW: 'https://example.com/app-sw.js' });
        const handler = createInstallHandler(deps);
        await expect(handler({}, vi.fn())).resolves.toBeUndefined();
    });

    it('calls onInstallDone even when importScripts throws', async () => {
        globalThis.importScripts = vi.fn(() => {
            throw new Error('importScripts failed');
        });
        const deps = makeInstallDeps({ appSW: 'https://example.com/app-sw.js' });
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.onInstallDone).toHaveBeenCalledTimes(1);
    });

    it('calls callChildHandlers', async () => {
        const deps = makeInstallDeps();
        const handler = createInstallHandler(deps);
        const event = {};
        const callChildHandlers = vi.fn();
        await handler(event, callChildHandlers);
        expect(callChildHandlers).toHaveBeenCalledWith(event);
    });

    it('calls onInstallDone', async () => {
        const deps = makeInstallDeps();
        const handler = createInstallHandler(deps);
        await handler({}, vi.fn());
        expect(deps.onInstallDone).toHaveBeenCalledTimes(1);
    });
});

describe('createActivateHandler', () => {
    it('calls claimClients', async () => {
        const deps = makeActivateDeps();
        const handler = createActivateHandler(deps);
        await handler({}, vi.fn());
        expect(deps.swContext.claimClients).toHaveBeenCalledTimes(1);
    });

    it('calls onSecurityViolation when site is blocked', async () => {
        const deps = makeActivateDeps({ isBlocked: true });
        const handler = createActivateHandler(deps);
        await handler({}, vi.fn());
        expect(deps.onSecurityViolation).toHaveBeenCalledTimes(1);
    });

    it('does not call onSecurityViolation when site is not blocked', async () => {
        const deps = makeActivateDeps({ isBlocked: false });
        const handler = createActivateHandler(deps);
        await handler({}, vi.fn());
        expect(deps.onSecurityViolation).not.toHaveBeenCalled();
    });

    it('calls callChildHandlers', async () => {
        const deps = makeActivateDeps();
        const handler = createActivateHandler(deps);
        const event = {};
        const callChildHandlers = vi.fn();
        await handler(event, callChildHandlers);
        expect(callChildHandlers).toHaveBeenCalledWith(event);
    });

    it('still resolves without throwing when claimClients rejects', async () => {
        const deps = makeActivateDeps({
            claimClients: vi.fn(() => Promise.reject(new Error('claim failed'))),
        });
        const handler = createActivateHandler(deps);
        await expect(handler({}, vi.fn())).resolves.toBeUndefined();
    });
});

describe('createInstallHandler skipWaiting rejection', () => {
    it('still resolves without throwing when skipWaiting rejects', async () => {
        const deps = makeInstallDeps({
            skipWaiting: vi.fn(() => Promise.reject(new Error('skipWaiting failed'))),
        });
        const handler = createInstallHandler(deps);
        await expect(handler({}, vi.fn())).resolves.toBeUndefined();
    });
});
