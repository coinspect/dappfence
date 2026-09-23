import { expect, test } from '../sw-fixtures';
import type { Page } from '@playwright/test';

test.describe('Fake Time - Basic Functionality', () => {
    ['once', 'again'].forEach((x) =>
        test(`verifies time manipulation can be performed ${x} - forward and backward time travel with validation`, async ({
            page,
            swHelper,
        }) => {
            await swHelper.setVersion('latest', 'simple-app');
            await page.goto('/sign.html');

            await expect(page).toHaveTitle('Personal Message Signing');
            const DAYS_IN_MS = 24 * 60 * 60 * 1000;
            const addDays = (days: number) =>
                new Date(new Date(Date.now() + days * DAYS_IN_MS)).toISOString().split('T')[0];
            const getBrowserDate = async () =>
                await page.evaluate(() => new Date().toISOString().split('T')[0]);

            // initially the time must be in-sync
            expect(await getBrowserDate()).toEqual(addDays(0));

            await swHelper.setFakeTime('+0d');
            expect(await getBrowserDate()).toEqual(addDays(0));

            await swHelper.setFakeTime('+20d');
            expect(await getBrowserDate()).toEqual(addDays(20));

            await swHelper.setFakeTime('-20d');
            expect(await getBrowserDate()).toEqual(addDays(-20));

            await swHelper.setFakeTime('+0d');
            expect(await getBrowserDate()).toEqual(addDays(0));

            await swHelper.setFakeTime('+2d');
            expect(await getBrowserDate()).toEqual(addDays(2));
        })
    );
});

test.describe('Fake Time - HTTP Cache Behavior', () => {
    async function getBrowserFetch(page: Page, url: string) {
        return await page.evaluate(
            async ({ url }) => {
                const response = await fetch(url, {
                    //cache: 'force-cache', // Prioritize the cache over a network request
                });
                return response.text();
            },
            {
                url,
            }
        );
    }

    test('verifies browser bypasses cache with default Cache-Control headers (no cache)', async ({
        page,
        baseURL,
        swHelper,
    }) => {
        await swHelper.setVersion('latest', 'simple-app');
        const initial = await getBrowserFetch(page, baseURL);
        await swHelper.setVersion('1.0.1', 'simple-app');
        const ver1 = await getBrowserFetch(page, baseURL);
        expect(ver1).not.toEqual(initial);
        await swHelper.setVersion('latest', 'simple-app');
        expect(await getBrowserFetch(page, baseURL)).not.toEqual(ver1);
    });

    test('verifies browser serves cached content when Cache-Control max-age is set', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app',
            appVersion: 'latest',
            responseHeaders: [
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=7200', // 2 hours
                    },
                },
            ],
        });

        const initial = await getBrowserFetch(page, baseURL);
        await swHelper.setVersion('1.0.1', 'simple-app');
        const ver1 = await getBrowserFetch(page, baseURL);
        expect(ver1).toEqual(initial);
        await swHelper.setVersion('1.0.1', 'latest');
        expect(await getBrowserFetch(page, baseURL)).toEqual(ver1);
    });

    test('verifies cached resources are served until time manipulation triggers cache expiration', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app',
            appVersion: 'latest',
            responseHeaders: [
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=7200', // 2 hours
                    },
                },
            ],
        });
        const initial = await getBrowserFetch(page, baseURL);

        await swHelper.setFakeTime('+30s');
        await swHelper.setVersion('1.0.1', 'simple-app');
        const initial2 = await getBrowserFetch(page, baseURL);
        expect(initial).toEqual(initial2);

        await swHelper.setFakeTime('+1d');
        const ver1 = await getBrowserFetch(page, baseURL);
        expect(ver1).not.toEqual(initial);
    });

    // NOTE: Browser page load completion and cache behavior tracking are unreliable due to non-deterministic
    // browser behavior (potentially influenced by libfaketime)
    test.fixme(
        'verifies cached resources are served until time manipulation triggers cache expiration using server response tracking',
        async ({ page, swHelper }, testInfo) => {
            let clientResponses = [];
            const client = await page.context().newCDPSession(page);
            await client.send('Network.enable');
            client.on('Network.responseReceived', (params) => {
                const data = {
                    url: params.response.url,
                    fromCache: !!(
                        params.response.fromDiskCache ||
                        params.response.fromPrefetchCache ||
                        params.response.fromEarlyHints
                    ),
                    requestTime: new Date(params.response.responseTime).toISOString(),
                    // headers: params.response.headers,
                };
                console.log(data);
                clientResponses.push(data);
            });
            // We want to give the page time to load all the JavaScript.
            // Also, some files are loaded from the cache anyway (even with the updated time).
            // In the case of the index file, it is also served from the cache erratically.
            async function expectCounts(cant: number) {
                const isJs = (url: string) => url.endsWith('.js') || url.includes('dappfence.js');
                let counters: [string, number][];
                while (true) {
                    const responses = await swHelper.getServerResponses();
                    const counts = responses.reduce(
                        (acc, r) => ({ ...acc, [r.url]: (acc[r.url] || 0) + 1 }),
                        {}
                    );
                    const fromCache = clientResponses.filter((x) => x.fromCache);
                    if (fromCache.length > 0) {
                        console.warn(
                            'Some URLs were served from the cache - adjusting counters accordingly',
                            fromCache.map((x) => x.url)
                        );
                        for (const fc of fromCache) {
                            counts[fc.url] = (counts[fc.url] || 0) + 1;
                        }
                    }

                    counters = Object.entries<number>(counts);
                    const scripts = counters.filter(([url]) => isJs(url));
                    if (!scripts.some(([, count]) => count < cant)) {
                        break;
                    }
                    console.log(
                        testInfo.title,
                        'Waiting for page load',
                        responses.map((u) => u.url),
                        clientResponses
                    );
                    await page.waitForTimeout(500);
                }
                const others = counters.filter(([url]) => !isJs(url));
                for (const [url, c] of others) {
                    if (url.endsWith('/sw-api/status')) {
                        // Sometimes the app checks the status before the service worker is ready.
                    } else if (url.endsWith('/integrity-manifest.json')) {
                        expect(c, `manifest not reloaded (install event called only once)`).toBe(1);
                    } else {
                        expect(c, `${url} count is wrong ${c} != ${cant}`).toBe(cant);
                    }
                }
            }

            await swHelper.setServerTestParameters({
                appName: 'simple-app',
                appVersion: 'latest',
                saveResponses: true,
                responseHeaders: [
                    {
                        match: '*',
                        headers: {
                            'Cache-Control': 'max-age=7200', // 2 hours
                        },
                    },
                ],
            });

            await page.goto('');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            await swHelper.waitForServiceWorkerActivation();
            const r1 = await swHelper.getServerResponses();

            await swHelper.setFakeTime('+30m');
            await page.goto('');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            const r2 = await swHelper.getServerResponses();
            // No new requests, still taking everything from the cache
            expect(r1).toEqual(r2);

            // After 3 hours
            clientResponses = [];
            await swHelper.setFakeTime('+3h');
            await page.goto('');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            // Waiting for service worker activation is useless because the service worker doesn't go through the activation cycle again.
            // We want to give the page time to call register again
            await expectCounts(2);

            // After a day + 1 hour
            await swHelper.setFakeTime('+25h');
            await page.goto('');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            await expectCounts(3);
        }
    );
});
