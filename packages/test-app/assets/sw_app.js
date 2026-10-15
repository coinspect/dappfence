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

    // Child-SW probes for redirect-behavior tests. See
    // packages/test-app/test/common/sw-child-fetch.spec.ts. Log lines prefixed
    // `[child-probe]` so tests can waitForServiceWorkerMessage on them.
    // Pattern: /child/<mode>/<target> — <mode> picks the strategy, <target>
    // (with its leading slash) is what the child fetches or points at.
    if (url.pathname.startsWith('/child/')) {
        const rest = url.pathname.slice('/child/'.length);
        const slash = rest.indexOf('/');
        if (slash > 0) {
            const mode = rest.slice(0, slash);
            const target = rest.slice(slash);
            log(
                `[child-probe] mode=${mode} target=${target} destination=${event.request.destination || '""'}`
            );
            if (mode === 'follow') {
                event.respondWith(fetch(target, { redirect: 'follow' }));
                return;
            }
            if (mode === 'manual') {
                event.respondWith(fetch(target, { redirect: 'manual' }));
                return;
            }
            if (mode === 'error') {
                event.respondWith(
                    fetch(target, { redirect: 'error' }).catch(
                        () => new Response('child redirect:error threw', { status: 502 })
                    )
                );
                return;
            }
            if (mode === 'respond-302') {
                event.respondWith(
                    new Response(null, { status: 302, headers: { Location: target } })
                );
                return;
            }
            if (mode === 'respond-302-ext') {
                // target is /host/path → Location: http://host/path
                // Must be http:// — Playwright's proxy intercepts http
                // transparently, but https:// goes through CONNECT which tries
                // a real TCP connection to the (fake) hostname and fails.
                event.respondWith(
                    new Response(null, {
                        status: 302,
                        headers: { Location: 'http:/' + target },
                    })
                );
                return;
            }
            if (mode === 'add-headers') {
                const injected = {
                    'x-child-injected': '1',
                    'x-dappfence': 'forged',
                };
                event.respondWith(
                    fetch(target, { headers: injected }).then((r) => {
                        const headers = new Headers(r.headers);
                        for (const [k, v] of Object.entries(injected)) {
                            headers.set(k, v);
                        }
                        return new Response(r.body, {
                            status: r.status,
                            statusText: r.statusText,
                            headers,
                        });
                    })
                );
                return;
            }
            if (mode === 'post') {
                // Child flips GET → POST with a tampered body. Outer FetchEvent
                // (from the browser) is still GET with destination="", so
                // DappFence's method filter SKIPs verification — the method
                // change is invisible at the outer SW. Pins the gap.
                event.respondWith(fetch(target, { method: 'POST', body: 'tampered-by-child' }));
                return;
            }
        }
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
