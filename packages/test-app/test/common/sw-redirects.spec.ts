/**
 * End-to-end tests for server-side redirect handling.
 *
 * Two shapes of redirect reach the SW:
 *
 *   Navigation (document) — the FetchEvent request has redirect:'manual'
 *   (per fetch spec for top-level nav). Our SW's fetch() returns an
 *   opaque-redirect response; shouldSkipVerification lets it pass through,
 *   and the browser re-dispatches a new fetch event for the destination,
 *   which gets verified normally.
 *
 *   Subresource (script/img/etc.) — the FetchEvent request has
 *   redirect:'follow'. Our SW's fetch() consumes the chain internally and
 *   returns the final response (response.redirected === true,
 *   response.url === final URL). The manifest-key lookup must therefore
 *   be driven by response.url, not req.url — the source path has no body
 *   of its own, and keying by the original URL turns every legitimate
 *   same-origin redirect into a NOT_FOUND block.
 */
import { expect, test } from '../sw-fixtures';

test.describe('server-side redirect handling', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();
    });

    test('navigation 302 to a manifest-known page passes verification', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: [
                {
                    pattern: '/redirect-to-front',
                    formula: 'empty',
                    statusCode: 302,
                },
            ],
            responseHeaders: [
                {
                    match: '/redirect-to-front',
                    headers: {
                        Location: '/front-page.html',
                    },
                },
            ],
        });

        await page.goto('/redirect-to-front');

        await expect(page).not.toHaveURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
    });

    test('navigation 302 to an unknown path triggers the security warning', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: [
                {
                    pattern: '/redirect-to-ghost',
                    formula: 'empty',
                    statusCode: 302,
                },
                {
                    pattern: '/ghost-page.html',
                    formula: 'empty',
                    statusCode: 200,
                    contentType: 'text/html',
                },
            ],
            responseHeaders: [
                {
                    match: '/redirect-to-ghost',
                    headers: {
                        Location: '/ghost-page.html',
                    },
                },
            ],
        });

        // The redirect chain (/redirect-to-ghost → /ghost-page.html → block → warning)
        // confuses page.goto; swallow the aborted-navigation error and assert on the
        // final location.
        await page.goto('/redirect-to-ghost').catch(() => {});
        await page.waitForURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('Security Warning - Content Blocked');
    });

    test('navigation 302 back to / (resolved via directory-index pathRule) passes verification', async ({
        page,
        swHelper,
    }) => {
        // /index.html is intercepted to 302 → /, which the SW must resolve back
        // to /index.html via the directory-index rule before the manifest lookup can succeed.
        await swHelper.setServerTestParameters({
            intercept: [
                {
                    pattern: '/index.html',
                    formula: 'empty',
                    statusCode: 302,
                },
            ],
            responseHeaders: [
                {
                    match: '/index.html',
                    headers: {
                        Location: '/',
                    },
                },
            ],
        });

        await page.goto('/index.html');

        await expect(page).not.toHaveURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('subresource 302 to a manifest-known script loads and executes', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: [
                {
                    pattern: '/redirect-to-app.js',
                    formula: 'empty',
                    statusCode: 302,
                },
            ],
            responseHeaders: [
                {
                    match: '/redirect-to-app.js',
                    headers: {
                        Location: '/app.js',
                    },
                },
            ],
        });

        const loadResult = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const s = document.createElement('script');
                    s.src = '/redirect-to-app.js';
                    s.type = 'module';
                    s.onload = () => resolve('loaded');
                    s.onerror = () => resolve('error');
                    document.head.appendChild(s);
                })
        );

        expect(loadResult).toBe('loaded');
        await expect(page).not.toHaveURL(/.*\/sw-api/);
    });

    test('subresource 302 to an unknown script is blocked and surfaces the security warning', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: [
                {
                    pattern: '/redirect-to-ghost.js',
                    formula: 'empty',
                    statusCode: 302,
                },
                {
                    pattern: '/ghost.js',
                    formula: 'empty',
                    statusCode: 200,
                    contentType: 'application/javascript',
                },
            ],
            responseHeaders: [
                {
                    match: '/redirect-to-ghost.js',
                    headers: {
                        Location: '/ghost.js',
                    },
                },
            ],
        });

        const loadResult = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const s = document.createElement('script');
                    s.src = '/redirect-to-ghost.js';
                    s.type = 'module';
                    s.onload = () => resolve('loaded');
                    s.onerror = () => resolve('error');
                    document.head.appendChild(s);
                })
        );

        expect(loadResult).toBe('error');
        await page.waitForURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('Security Warning - Content Blocked');
    });

    test('undeclared cross-origin redirect is blocked (Phase 3 forcing-function)', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        const port = new URL(baseURL!).port;
        await swHelper.setServerTestParameters({
            intercept: [{ pattern: '/undeclared-xorig', formula: 'empty', statusCode: 302 }],
            responseHeaders: [
                {
                    match: '/undeclared-xorig',
                    headers: { Location: `http://attacker.example:${port}/front-page.html` },
                },
            ],
        });

        await page.goto('/undeclared-xorig').catch(() => {});
        await page.waitForURL(/.*\/sw-api/);

        await expect(page).toHaveTitle('Security Warning - Content Blocked');
        expect(page.url()).not.toContain('attacker.example');
    });

    test.describe('cross-origin redirects (dedicated dev-server :12345)', () => {
        test.beforeEach(async ({ swHelper }) => {
            await swHelper.setServerTestParameters({ port: 12345 });
        });

        test.afterEach(async ({ swHelper }) => {
            await swHelper.clearServerTestParameters(12345);
        });

        test('authorized cross-origin migration redirect lands on migrated.site.com', async ({
            page,
            swHelper,
        }) => {
            await swHelper.setServerTestParameters({
                intercept: [{ pattern: '/legacy-page', formula: 'empty', statusCode: 302 }],
                responseHeaders: [
                    { match: '/legacy-page', headers: { Location: '/should-be-ignored' } },
                ],
            });

            await page.goto('/legacy-page');

            await expect(page).toHaveURL(/migrated\.site\.com:12345/);
            await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
        });
    });
});
