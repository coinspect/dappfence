import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createEmergencyPanel,
    resetMessageOverrides,
    setMessageOverrides,
    showEmergencyPanel,
} from '../emergency-panel.js';
import { handleSecurityMessage } from '../security-handler.js';

afterEach(() => resetMessageOverrides());

function fakeWindow(languages = []) {
    const listeners = {};
    return {
        navigator: { languages },
        document: { documentElement: { innerHTML: '<body>app</body>' } },
        addEventListener: vi.fn((type, fn, capture) => {
            listeners[type] = { fn, capture };
        }),
        listeners,
    };
}

describe('createEmergencyPanel', () => {
    it('returns the styled panel fragment', () => {
        const html = createEmergencyPanel();
        expect(html).toMatch(/^<head>/);
        expect(html).toContain('Security Action Required');
        expect(html).not.toContain('/* @styles */');
    });

    // Scripts inserted through innerHTML never run, so behaviour must be
    // attached by showEmergencyPanel, not shipped in the markup.
    it('contains no <script>', () => {
        expect(createEmergencyPanel()).not.toMatch(/<script/i);
    });
});

describe('showEmergencyPanel', () => {
    it('replaces the page with the panel', () => {
        const win = fakeWindow();
        showEmergencyPanel(win);
        expect(win.document.documentElement.innerHTML).toBe(createEmergencyPanel());
    });

    it('asks for confirmation before the page unloads', () => {
        const win = fakeWindow();
        showEmergencyPanel(win);
        const event = { preventDefault: vi.fn(), returnValue: undefined };
        win.listeners.beforeunload.fn(event);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.returnValue).toBeTruthy();
    });

    it('blocks clicks on links, including on their children, in the capture phase', () => {
        const win = fakeWindow();
        showEmergencyPanel(win);
        const { fn, capture } = win.listeners.click;
        expect(capture).toBe(true);

        const inLink = {
            target: { closest: (sel) => (sel === 'a' ? {} : null) },
            preventDefault: vi.fn(),
        };
        fn(inLink);
        expect(inLink.preventDefault).toHaveBeenCalled();

        const outside = { target: { closest: () => null }, preventDefault: vi.fn() };
        fn(outside);
        expect(outside.preventDefault).not.toHaveBeenCalled();
    });
});

describe('emergency panel text', () => {
    const contact = 'emergency.contact';

    it('renders the built-in English text with no overrides', () => {
        const html = createEmergencyPanel();
        expect(html).toContain('<title>Critical Security Notice</title>');
        expect(html).toContain('verified support channel');
        expect(html).not.toMatch(/\{\{t:/);
    });

    it('uses verified overrides for the viewer locale, escaped', () => {
        setMessageOverrides({ es: { [contact]: 'Escribinos a <soporte@example.com>' } });
        const win = fakeWindow(['es-AR']);
        showEmergencyPanel(win);
        expect(win.document.documentElement.innerHTML).toContain(
            'Escribinos a &lt;soporte@example.com&gt;'
        );
    });

    it('accepts overrides only once', () => {
        setMessageOverrides({ en: { [contact]: 'first' } });
        setMessageOverrides({ en: { [contact]: 'second' } });
        expect(createEmergencyPanel()).toContain('first');
    });

    it('drops invalid override entries', () => {
        setMessageOverrides({ en: { [contact]: 42, 'emergency.title': 'Ok' } });
        const html = createEmergencyPanel();
        expect(html).toContain('Ok');
        expect(html).toContain('verified support channel');
    });

    it('uses the localized leave warning', () => {
        setMessageOverrides({ es: { 'emergency.leaveWarning': '¿Recargar?' } });
        const win = fakeWindow(['es']);
        showEmergencyPanel(win);
        const event = { preventDefault: vi.fn(), returnValue: undefined };
        win.listeners.beforeunload.fn(event);
        expect(event.returnValue).toBe('¿Recargar?');
    });
});

describe('DAPPFENCE_MESSAGES from the service worker', () => {
    const overrides = { en: { 'emergency.contact': 'From the SW' } };
    const data = { type: 'DAPPFENCE_MESSAGES', overrides };

    it('applies overrides from a browser-dispatched event', () => {
        handleSecurityMessage({ isTrusted: true, data });
        expect(createEmergencyPanel()).toContain('From the SW');
    });

    // Page scripts can dispatch synthetic `message` events on
    // navigator.serviceWorker; only the browser sets isTrusted.
    it('ignores a synthetic event', () => {
        handleSecurityMessage({ isTrusted: false, data });
        expect(createEmergencyPanel()).not.toContain('From the SW');
    });
});
