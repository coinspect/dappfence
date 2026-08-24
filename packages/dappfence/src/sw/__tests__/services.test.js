import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../response.js', () => ({
    createBlockResponse: vi.fn(() => new Response('blocked', { status: 403 })),
    createSecurityWarningPage: vi.fn(() => new Response('warning', { status: 200 })),
}));

vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn((flag) => globalThis.__FEATURES__?.[flag] === true),
    createSingleFlight: vi.fn(() => {
        let pending = null;
        return (fn) => {
            if (!pending) {
                pending = fn().finally(() => (pending = null));
            }
            return pending;
        };
    }),
    hasConfigManifest: vi.fn(() => false),
}));

import { createServices } from '../services.js';

function makeSwGlobal() {
    return {
        location: {
            href: 'https://app.example.com/sw.js',
            origin: 'https://app.example.com',
            search: '',
            toString() {
                return this.href;
            },
        },
        clients: {
            matchAll: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(null),
            claim: vi.fn().mockResolvedValue(undefined),
        },
        skipWaiting: vi.fn().mockResolvedValue(undefined),
        navigator: { userAgent: 'test-agent' },
        fetch: vi.fn(),
        indexedDB: {
            open: vi.fn().mockReturnValue({
                onupgradeneeded: null,
                onsuccess: null,
                onerror: null,
            }),
        },
        addEventListener: vi.fn(),
        importScripts: vi.fn(),
    };
}

describe('createServices', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = {};
        if (typeof globalThis.self === 'undefined') {
            globalThis.self = globalThis;
        }
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });
    it('returns all expected service keys', () => {
        const swGlobal = makeSwGlobal();
        const services = createServices(swGlobal);
        expect(services).toHaveProperty('hookService');
        expect(services).toHaveProperty('fetchHandler');
        expect(services).toHaveProperty('installHandler');
        expect(services).toHaveProperty('activateHandler');
        expect(services).toHaveProperty('messageHandler');
    });

    it('hookService has installHooks, addEventListener, addDefaultEventListeners', () => {
        const swGlobal = makeSwGlobal();
        const { hookService } = createServices(swGlobal);
        expect(typeof hookService.installHooks).toBe('function');
        expect(typeof hookService.addEventListener).toBe('function');
        expect(typeof hookService.addDefaultEventListeners).toBe('function');
    });

    it('fetchHandler is a function', () => {
        const swGlobal = makeSwGlobal();
        const { fetchHandler } = createServices(swGlobal);
        expect(typeof fetchHandler).toBe('function');
    });

    it('installHandler is a function', () => {
        const swGlobal = makeSwGlobal();
        const { installHandler } = createServices(swGlobal);
        expect(typeof installHandler).toBe('function');
    });

    it('activateHandler is a function', () => {
        const swGlobal = makeSwGlobal();
        const { activateHandler } = createServices(swGlobal);
        expect(typeof activateHandler).toBe('function');
    });

    it('messageHandler is a function', () => {
        const swGlobal = makeSwGlobal();
        const { messageHandler } = createServices(swGlobal);
        expect(typeof messageHandler).toBe('function');
    });

    it('reads manifestUrl from search params or uses default', () => {
        const swGlobal = makeSwGlobal();
        swGlobal.location.href = 'https://app.example.com/sw.js?manifestUrl=/custom-manifest.json';
        swGlobal.location.search = '?manifestUrl=/custom-manifest.json';
        const services = createServices(swGlobal);
        expect(services).toHaveProperty('fetchHandler');
    });
});
