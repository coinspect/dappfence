/**
 * Service Worker Context
 *
 * Wraps all access to the service worker global scope (`self`).
 * Every property is a function so the underlying value is read on each call,
 * making it easy to swap or mock in tests.
 *
 * In production, createSwContext() captures the real `self`.
 * In tests, provide a mock object to avoid needing a browser environment.
 */

/**
 * @param {object} [swGlobal=self] - The service worker global scope
 */
export function createSwContext(swGlobal = self) {
    return {
        // Location
        getLocationHref: () => swGlobal.location.href,
        getLocationOrigin: () => swGlobal.location.origin,
        getLocation: () => swGlobal.location,

        // Clients API
        matchAllClients: (opts) => swGlobal.clients.matchAll(opts),
        getClient: (id) => swGlobal.clients.get(id),
        claimClients: () => swGlobal.clients.claim(),

        // Lifecycle
        skipWaiting: () => swGlobal.skipWaiting(),

        // Environment
        getUserAgent: () => swGlobal.navigator.userAgent,

        // Network
        fetch: (input, init) => swGlobal.fetch(input, init),

        // Background Sync — tag retry for telemetry drains after a POST failure.
        registerSync: (tag) => swGlobal.registration.sync.register(tag),
    };
}
