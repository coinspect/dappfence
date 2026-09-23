// Generic App Service Worker - no DappFence dependencies
// This is what a typical app SW looks like

function log(...args) {
    console.log('%c[Simple App SW Main]', 'color:yellow', self.location.href, ...args);
}
log('Main, Service worker loaded start');

// Can be called here or during `install`, if it is not in the right state, it doesn't have any effect
// Calling skipWaiting() immediately starts activation of the new service worker
self.skipWaiting().catch((err) => console.error('[SW Main] skipWaiting failed:', err));

// same as self.addEventListener
addEventListener('message', (event) => {
    // event is an ExtendableMessageEvent object
    log('The client sent me a message:', event.data);
    event.source.postMessage('Hi client from Simple App');
});

self.addEventListener('install', (event) => {
    log('install listener');
    self.skipWaiting()
        .then(() => log('done skip waiting'))
        .catch((err) => log('error skip waiting', err));
});

self.addEventListener('activate', (event) => {
    log('activate listener');
    event.waitUntil(self.clients.claim());
});

// self.addEventListener('custom_event', (event) => {
//     log('custom_event', event);
// });

// Simple caching strategy
self.addEventListener('fetch', (event) => {
    log(
        'DESTINATION_CHECK: fetch listener',
        event.request.method,
        event.request.url,
        'destination:',
        event.request.destination || '""'
    );
    const originalRequest = event.request;
    const url = new URL(originalRequest.url);
    log('fetch listener', url.pathname);
    if (url.pathname.startsWith('/simple-app/status')) {
        log('fetch listener, handling API endpoint:', url.pathname);
        event.respondWith(
            new Response(JSON.stringify({ status: self.simpleAppStatus() }, null, 2), {
                headers: { 'Content-Type': 'application/json' },
            })
        );
        return;
    }

    if (event.request.method !== 'GET') {
        return;
    }
    event.respondWith(fetch(event.request));
});

log('Main, Service worker loaded done');
// Load utility functions, see: https://chromestatus.com/feature/5748516353736704
// async function bg() {
//     await fetch('/integrity-manifest.json');
//     importScripts('sw_utils.js');
// }
// bg();
importScripts('sw_utils.js');
