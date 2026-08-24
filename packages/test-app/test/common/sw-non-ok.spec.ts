/**
 * End-to-end tests for non-OK HTTP response verification.
 *
 * With SW active, the verifier now processes navigation responses regardless
 * of HTTP status code. Sub-resources with non-OK status are still skipped.
 */
import { expect, test } from '../sw-fixtures';

test.describe('non-OK response verification', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        const url = await swHelper.waitForServiceWorkerActivation();
        if (swCapture || testInfo.project.name.startsWith('simple-app-sw-fixed')) {
            expect(url).toContain('appSW=sw_app.js');
        }
    });

    test('should block with hard message when known page has tampered body and non-OK status', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/',
            formula: 'default',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });

    test('should pass through when known page has correct body and non-OK status', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/',
            formula: 'unchanged',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        // SW verifies MATCH — passes the 404 response through without blocking
        await expect(page).not.toHaveURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('should block when a known script returns a non-OK status', async ({
        page,
        swHelper,
    }, testInfo) => {
        test.skip(
            testInfo.project.name.startsWith('simple-app-sw-capture'),
            'app.js is not loaded by index.html in sw-capture variant'
        );
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/app.js',
            formula: 'empty',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        // Non-OK script is now verified — empty 404 body mismatches the manifest → security block
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });

    test('should execute no-cors script when its hash matches the manifest', async ({ page }) => {
        // no-cors-test.js is loaded without crossorigin → mode=no-cors. The SW upgrades the
        // request to cors+omit so the response body is readable, then verifies the hash against
        // the manifest. Hash matches → pass through and execute normally (no opaque rewrite).
        await page.goto('about:blank');
        await page.goto('');
        const ran = await page.evaluate(
            () => (window as unknown as { __noCorsScriptRan?: string }).__noCorsScriptRan
        );
        expect(ran).toBe('yes');
    });

    test('should fail to load no-cors script from a server that does not support CORS', async ({
        page,
    }) => {
        // DappFence forces cors+omit on every no-cors script request, so the response body
        // is readable for hash verification. This is a hard requirement: if the origin server
        // does not respond with Access-Control-Allow-Origin, the browser rejects the response,
        // and the script never executes (TypeError — treated as a network failure).
        // cors-unsupported-cdn.com is a test server that intentionally returns no CORS headers.
        await page.goto('about:blank');
        await page.goto('');
        const loadError = await page.evaluate(() => {
            return new Promise<string>((resolve) => {
                const script = document.createElement('script');
                script.src = 'http://cors-unsupported-cdn.com/no-cors-test.js';
                script.onload = () => resolve('loaded');
                script.onerror = () => resolve('error');
                document.head.appendChild(script);
            });
        });
        expect(loadError).toBe('error');
    });
});
