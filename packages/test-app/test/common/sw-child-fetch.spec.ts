import { expect, test } from '../sw-fixtures';

const isChildSwProject = (name: string) => name.includes('sw-fixed') || name.includes('sw-capture');

test.describe('DF child SW fetch behavior (real DF code paths)', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        if (!isChildSwProject(testInfo.project.name)) {
            test.skip(true, 'child SW routes only exist in sw-fixed / sw-capture builds');
        }
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();
    });

    test.describe('child SW overrides the browser default redirect mode', () => {
        test('nav redirect:manual → opaque-redirect pass-through, browser re-dispatches destination', async ({
            page,
            swHelper,
        }) => {
            await swHelper.setServerTestParameters({
                intercept: [{ pattern: '/child-nav-src', formula: 'empty', statusCode: 302 }],
                responseHeaders: [
                    { match: '/child-nav-src', headers: { Location: '/front-page.html' } },
                ],
            });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=manual target=/child-nav-src'
            );
            const opaqueSeenP = swHelper.waitForServiceWorkerMessage(
                '/child/manual/child-nav-src GET destination=document response.ok=false response.type=opaqueredirect'
            );
            const frontPageP = swHelper.waitForServiceWorkerMessage(
                'front-page.html method:GET mode:navigate destination:document'
            );

            await page.goto('/child/manual/child-nav-src');

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=manual');
            expect((await opaqueSeenP).msg.text()).toContain('response.type=opaqueredirect');
            expect((await frontPageP).msg.text()).toContain('front-page.html method:GET');
            await expect(page).toHaveURL(/\/front-page\.html$/);
            await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
        });

        test('nav redirect:follow → URL bar stuck at source, destination body rendered (breakage)', async ({
            page,
            swHelper,
        }) => {
            await swHelper.setServerTestParameters({
                intercept: [{ pattern: '/child-nav-src', formula: 'empty', statusCode: 302 }],
                responseHeaders: [
                    { match: '/child-nav-src', headers: { Location: '/front-page.html' } },
                ],
            });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=follow target=/child-nav-src'
            );

            const navResponse = await page.goto('/child/follow/child-nav-src');

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=follow');
            expect(navResponse?.status()).toBe(200);
            // The browser url is not: /front-page.html which is problematic !!!
            expect(navResponse?.url()).toContain('/child/follow/child-nav-src');
            await expect(page).toHaveURL(/\/child\/follow\/child-nav-src/);
            await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
        });

        test('Subresource redirect:manual → script tag errors on opaque-redirect', async ({
            page,
            swHelper,
        }) => {
            await swHelper.setServerTestParameters({
                intercept: [{ pattern: '/child-sub-src.js', formula: 'empty', statusCode: 302 }],
                responseHeaders: [{ match: '/child-sub-src.js', headers: { Location: '/app.js' } }],
            });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=manual target=/child-sub-src.js'
            );
            const opaqueSeenP = swHelper.waitForServiceWorkerMessage(
                '/child/manual/child-sub-src.js GET destination=script response.ok=false response.type=opaqueredirect'
            );

            const loadResult = await page.evaluate(
                () =>
                    new Promise<string>((resolve) => {
                        const s = document.createElement('script');
                        s.src = '/child/manual/child-sub-src.js';
                        s.type = 'module';
                        s.onload = () => resolve('loaded');
                        s.onerror = () => resolve('error');
                        document.head.appendChild(s);
                    })
            );

            expect((await probeFiredP).msg.text()).toContain('destination=script');
            expect((await opaqueSeenP).msg.text()).toContain('response.type=opaqueredirect');
            expect(loadResult).toBe('error');
        });
    });

    test.describe('child SW tampers with headers / method', () => {
        test('add-headers → forged x-dappfence headers visible on response', async ({
            page,
            swHelper,
        }) => {
            await swHelper.setServerTestParameters({ saveResponses: true });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=add-headers target=/capture/child-headers-probe'
            );

            const result = await page.evaluate(async () => {
                try {
                    const r = await fetch('/child/add-headers/capture/child-headers-probe');
                    return {
                        status: r.status,
                        xChildInjected: r.headers.get('x-child-injected'),
                        xDappfence: r.headers.get('x-dappfence'),
                    };
                } catch (_e) {
                    return null;
                }
            });

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=add-headers');
            expect(result?.status).toBe(200);
            expect(result?.xChildInjected).toBe('1');
            expect(result?.xDappfence).toBe('forged');
        });

        test('GET flipped to POST + tampered body → server sees POST+body; outer SW SKIPs (destination="")', async ({
            page,
            swHelper,
            request,
        }) => {
            await swHelper.setServerTestParameters({ saveResponses: true });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=post target=/capture/child-post-probe'
            );

            const status = await page.evaluate(async () => {
                try {
                    const r = await fetch('/child/post/capture/child-post-probe');
                    return r.status;
                } catch (_e) {
                    return 0;
                }
            });

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=post');
            expect(status).toBe(200);

            let captured: { method?: string; body?: string } | null = null;
            await expect
                .poll(async () => {
                    const r = await request.get('/api/test-responses');
                    const entries = (await r.json()) as Array<{
                        result: string;
                        requestPath: string;
                        method?: string;
                        body?: string;
                    }>;
                    const hit = entries.find(
                        (e) =>
                            e.result === 'capture' && e.requestPath === '/capture/child-post-probe'
                    );
                    if (hit) {
                        captured = { method: hit.method, body: hit.body };
                    }
                    return captured !== null;
                })
                .toBe(true);
            expect(captured!.method).toBe('POST');
            expect(captured!.body).toBe('tampered-by-child');
        });
    });

    test.describe('child SW synthesizes a 3xx response (no network fetch)', () => {
        test('nav respond 302 internal declared → verified synthesized 302 to /front-page.html', async ({
            page,
            swHelper,
        }) => {
            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=respond target=/front-page.html'
            );

            await page.goto('/child/respond/front-page.html?status=302');

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=respond');
            await expect(page).toHaveURL(/\/front-page\.html$/);
            await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
        });

        test('nav respond 302 internal UNDECLARED → blocked as REDIRECT_NOT_DECLARED', async ({
            page,
            swHelper,
        }) => {
            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=respond target=/no-such-page.html'
            );

            await page.goto('/child/respond/no-such-page.html?status=302').catch(() => {});
            await page.waitForURL(/.*\/sw-api/);

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=respond');
            await expect(page).toHaveTitle('Security Warning - Content Blocked');
        });

        test('nav respond 304 falls through to body verification (not treated as redirect)', async ({
            page,
            swHelper,
        }) => {
            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=respond target=/front-page.html'
            );

            await page.goto('/child/respond/front-page.html?status=304').catch(() => {});
            await page.waitForURL(/.*\/sw-api/);

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=respond');
            await expect(page).toHaveTitle('Security Warning - Content Blocked');
        });
    });

    test.describe('server 302 to cross-origin http:// — escape-to-attacker gap', () => {
        test('redirect:follow → SW sees final cross-origin URL, blocks via NOT_FOUND (breaks legit cross-origin exits)', async ({
            page,
            swHelper,
            baseURL,
        }) => {
            const port = new URL(baseURL!).port;
            await swHelper.setServerTestParameters({
                intercept: [{ pattern: '/xorig-src', formula: 'empty', statusCode: 302 }],
                responseHeaders: [
                    {
                        match: '/xorig-src',
                        headers: {
                            Location: `http://attacker.example:${port}/front-page.html`,
                        },
                    },
                ],
            });

            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                '[child-probe] mode=follow target=/xorig-src'
            );
            const outerSawAttackerP = swHelper.waitForServiceWorkerMessage(
                `http://attacker.example:${port}/front-page.html`
            );

            await page.goto('/child/follow/xorig-src').catch(() => {});
            await page.waitForURL(/.*\/sw-api/);

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=follow');
            expect((await outerSawAttackerP).msg.text()).toContain(
                `http://attacker.example:${port}/front-page.html`
            );
            await expect(page).toHaveTitle('Security Warning - Content Blocked');
            expect(page.url()).not.toContain('attacker.example');
        });

        test('child respond-302-ext → DF blocks before browser follows cross-origin via dev-proxy', async ({
            page,
            swHelper,
            baseURL,
        }) => {
            const port = new URL(baseURL!).port;
            const probeFiredP = swHelper.waitForServiceWorkerMessage(
                `[child-probe] mode=respond-302-ext target=/attacker.example:${port}/front-page.html`
            );

            await page
                .goto(`/child/respond-302-ext/attacker.example:${port}/front-page.html`)
                .catch(() => {});
            await page.waitForURL(/.*\/sw-api/);

            expect((await probeFiredP).msg.text()).toContain('[child-probe] mode=respond-302-ext');
            await expect(page).toHaveTitle('Security Warning - Content Blocked');
            await expect(page).not.toHaveURL(/attacker\.example/);
        });
    });
});

test.describe('POC browser platform (no DappFence, /withoutDappfence.html)', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('/withoutDappfence.html');
        await swHelper.waitForServiceWorkers(1);
        await swHelper.waitForServiceWorkerActivation();
        await page.reload();
    });

    test('SW-synthesized 302 at script tag → browser follows materialized Location (loaded)', async ({
        page,
        swHelper,
    }) => {
        const probeFiredP = swHelper.waitForServiceWorkerMessage(
            '[child-probe] mode=respond-302 target=/app.js'
        );

        const loadResult = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const s = document.createElement('script');
                    s.src = '/child/respond-302/app.js';
                    s.type = 'module';
                    s.onload = () => resolve('loaded');
                    s.onerror = () => resolve('error');
                    document.head.appendChild(s);
                })
        );

        expect((await probeFiredP).msg.text()).toContain('destination=script');
        expect(loadResult).toBe('loaded');
    });
});
