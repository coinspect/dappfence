import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.js';
import { handleSecurityMessage } from '../security-handler.js';

describe('SECURITY_BLOCK from the service worker', () => {
    const data = { type: MSG.SECURITY_BLOCK, warningUrl: '/blocked.html' };
    let replace;

    beforeEach(() => {
        replace = vi.fn();
        vi.stubGlobal('window', { location: { replace } });
    });
    afterEach(() => vi.unstubAllGlobals());

    // Runs first: a trusted redirect latches redirectAttempted for the module.
    // Page scripts can dispatch synthetic `message` events on
    // navigator.serviceWorker; only the browser sets isTrusted.
    it('ignores a synthetic event', () => {
        handleSecurityMessage({ isTrusted: false, data });
        expect(replace).not.toHaveBeenCalled();
    });

    it('redirects on a browser-dispatched event', () => {
        handleSecurityMessage({ isTrusted: true, data });
        expect(replace).toHaveBeenCalledWith('/blocked.html');
    });
});
