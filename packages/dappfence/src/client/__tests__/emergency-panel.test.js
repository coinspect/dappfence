import { describe, expect, it, vi } from 'vitest';
import { createEmergencyPanel, showEmergencyPanel } from '../emergency-panel.js';

function fakeWindow() {
    const listeners = {};
    return {
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
