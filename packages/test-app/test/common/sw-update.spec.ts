/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, SWHelper, test } from '../sw-fixtures';
import type { Page, TestInfo } from '@playwright/test';

/*
 * Ensures the Service Worker is installed and active before running each test.
 * These tests assume that the /index.html file is correct and has already been loaded at least once.
 */
//test.beforeEach(async ({ page,  swHelper }, testInfo) => {
async function beforeEach(
    { page, swHelper }: { page: Page; swHelper: SWHelper },
    testInfo: TestInfo
) {
    await page.goto('');
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
}

test.describe('should be able to reload the page from the test server after upgrade', () => {
    test('should be able to load default (latest) version', async ({
        page,
        swHelper,
    }, testInfo) => {
        await beforeEach({ page, swHelper }, testInfo);
        const response = await page.reload();
        expect(response.fromServiceWorker()).toBeTruthy();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });
    test('should be able to load version 1.0.1', async ({ page, swHelper }, testInfo) => {
        await swHelper.setVersion('1.0.1');
        await beforeEach({ page, swHelper }, testInfo);
        const response = await page.reload();
        expect(response.fromServiceWorker()).toBeTruthy();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('should be able to reload the page from the test server after upgrade', async ({
        page,
        swHelper,
    }, testInfo) => {
        await beforeEach({ page, swHelper }, testInfo);

        // Give the SW time to load
        await swHelper.setVersion('1.0.1');
        const response = await page.reload();
        expect(response.fromServiceWorker()).toBeTruthy();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test.fixme('should protect even after a call to update', async ({ page, swHelper }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app',
            appVersion: 'latest',
            saveResponses: true,
        });

        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
        await swHelper.interceptAndModifyPageContent('**/dappfence.js');
        await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            await registration.update();
        });
        // The request that takes dappfence never passes through the service worker, we must hook update
        await page.waitForURL(/.*\/sw-api/);
    });
});
