import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyServiceWorkerReady } from '../security-handler.js';
import { MSG } from '../../core/constants.js';

function installNavigatorMock(swProps = {}) {
    const mock = { serviceWorker: { addEventListener: vi.fn(), controller: null, ...swProps } };
    Object.defineProperty(globalThis, 'navigator', {
        value: mock,
        writable: true,
        configurable: true,
    });
}

function installWindowMock() {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { replace: vi.fn() } },
        writable: true,
        configurable: true,
    });
}

beforeEach(() => {
    installNavigatorMock();
    installWindowMock();
});

describe('setupSecurityMessageListener', () => {
    let setupSecurityMessageListener;

    beforeEach(async () => {
        vi.resetModules();
        ({ setupSecurityMessageListener } = await import('../security-handler.js'));
        installNavigatorMock();
        installWindowMock();
    });

    it('registers a message event listener on navigator.serviceWorker', () => {
        setupSecurityMessageListener();
        expect(navigator.serviceWorker.addEventListener).toHaveBeenCalledWith(
            'message',
            expect.any(Function)
        );
    });
});

describe('handleSecurityMessage', () => {
    let setupSecurityMessageListener;

    beforeEach(async () => {
        vi.resetModules();
        ({ setupSecurityMessageListener } = await import('../security-handler.js'));
        installNavigatorMock();
        installWindowMock();
    });

    function getHandler() {
        setupSecurityMessageListener();
        const calls = navigator.serviceWorker.addEventListener.mock.calls;
        return calls[calls.length - 1][1];
    }

    it('calls window.location.replace with warningUrl on SECURITY_BLOCK message', () => {
        const handler = getHandler();
        handler({ data: { type: MSG.SECURITY_BLOCK, warningUrl: '/sw-api/security-warning' } });
        expect(window.location.replace).toHaveBeenCalledWith('/sw-api/security-warning');
    });

    it('does not call replace a second time (idempotent via redirectAttempted)', () => {
        const handler = getHandler();
        handler({ data: { type: MSG.SECURITY_BLOCK, warningUrl: '/sw-api/security-warning' } });
        handler({ data: { type: MSG.SECURITY_BLOCK, warningUrl: '/sw-api/security-warning' } });
        expect(window.location.replace).toHaveBeenCalledTimes(1);
    });

    it('does not call replace for a different message type', () => {
        const handler = getHandler();
        handler({ data: { type: 'SOME_OTHER_TYPE', warningUrl: '/sw-api/security-warning' } });
        expect(window.location.replace).not.toHaveBeenCalled();
    });
});

describe('notifyServiceWorkerReady', () => {
    it('does nothing when there is no SW controller', () => {
        globalThis.navigator.serviceWorker.controller = null;
        expect(() => notifyServiceWorkerReady()).not.toThrow();
    });

    it('does nothing when navigator.serviceWorker is absent', () => {
        globalThis.navigator = {};
        expect(() => notifyServiceWorkerReady()).not.toThrow();
    });

    it('posts CLIENT_READY message when a controller is present', () => {
        const postMessage = vi.fn();
        globalThis.navigator.serviceWorker.controller = { postMessage };

        notifyServiceWorkerReady();

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: MSG.CLIENT_READY })
        );
    });
});
