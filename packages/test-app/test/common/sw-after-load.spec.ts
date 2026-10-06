/**
 * End-to-end tests for the Service Worker functionality.
 *
 * Ensures the Service Worker is installed and active before running each test.
 * These tests assume that the /index.html file is correct and has already been loaded at least once.
 */
import { expect, test } from '../sw-fixtures';
['index', 'front-page'].forEach((name) => {
    test.describe(`after-load (${name})`, () => {
        test.beforeEach(async ({ page, swHelper }, testInfo) => {
            if (name === 'front-page') {
                await page.goto('/front-page.html');
                await expect(page).toHaveTitle('DappFence - Front Page - Manifest Mode Example');
                await page.waitForURL('/');
            } else {
                await page.goto('');
            }
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

            const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
            const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
            if (swCapture) {
                // Wait for the first service worker (sw_register.js) to close after registering sw_app.js.
                // This ensures sw_app.js becomes the active service worker before proceeding with tests.
                // Note: Adding app.js to index.html would cause polling to /sw-api, preventing the first
                // service worker without the appSW parameter from closing, which would break this wait logic.
                await serviceWorkers[0].waitUntilClosed();
            }
            // We don't know which one is active, because sometimes the second one stays in loading state forever
            const url = await swHelper.waitForServiceWorkerActivation();
            if (swCapture || testInfo.project.name.startsWith('simple-app-sw-fixed')) {
                expect(url).toContain('appSW=sw_app.js');
            }
        });

        test('should be able to reload the page from the test server', async ({ page }) => {
            const response = await page.reload();
            expect(response.fromServiceWorker()).toBeTruthy();
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        });

        test('should block navigation when index.html is tampered', async ({ page, swHelper }) => {
            await swHelper.interceptAndModifyPageContent('**/');
            await page.goto('about:blank');
            await page.goto('');
            await page.waitForURL(/.*\/sw-api/);
        });

        test('should block fast when index.html is tampered with client already loaded', async ({
            page,
            swHelper,
        }) => {
            await swHelper.interceptAndModifyPageContent('**/');
            // Timing-robust: accept either race outcome.
            await page.goto('').catch(() => {}); // ERR_ABORTED OK, resolve OK
            await page.waitForURL(/.*\/sw-api/);
            await expect(page.getByText('Security Warning')).toBeVisible();
        });

        test('should block navigation when dappfence.js is tampered', async ({
            page,
            swHelper,
        }) => {
            await swHelper.interceptAndModifyPageContent('**/dappfence.js');
            await page.goto('');
            await page.waitForURL(/.*\/sw-api/);
        });

        test('should block navigation when app.js is tampered', async ({
            page,
            swHelper,
        }, testInfo) => {
            test.skip(
                testInfo.project.name.startsWith('simple-app-sw-capture'),
                "right now we don't support this case (app.js is not loaded by the index.html)"
            );
            await swHelper.interceptAndModifyPageContent('**/app.js');
            await page.goto('');
            await page.waitForURL(/.*\/sw-api/);
        });

        test('should block navigation if an external resource is tampered', async ({
            page,
            swHelper,
        }) => {
            await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');
            await page.goto('');
            await page.waitForURL(/.*\/sw-api/);
        });

        test('should allow normal navigation after dismissing a security block', async ({
            page,
            swHelper,
        }) => {
            await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');
            await page.goto('');
            await page.waitForURL(/.*\/sw-api/);
            // Accept all the confirmation alerts
            page.on('dialog', async (dialog) => {
                await dialog.accept();
            });
            await page.getByRole('button', { name: 'Remove Site Lock' }).click();
            await page.waitForURL('/');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

            await page.reload();
            await page.waitForURL('/');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        });
    });
});
