/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, SWHelper, test } from '../sw-fixtures';
import type { TestInfo } from '@playwright/test';

/*
 * Ensures the Service Worker is installed and active before running each test.
 * These tests assume that the /index.html file is correct and has already been loaded at least once.
 */
//test.beforeEach(async ({ page,  swHelper }, testInfo) => {
async function beforeEach({ swHelper }: { swHelper: SWHelper }, testInfo: TestInfo) {
    const page1 = await swHelper.newPage('first page');
    await page1.goto('');

    const page2 = await swHelper.newPage('second page');
    await page2.goto('');

    await expect(page1).toHaveTitle('DappFence - Manifest Mode Example');
    await expect(page2).toHaveTitle('DappFence - Manifest Mode Example');

    const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
    const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
    if (swCapture) {
        // Service worker registration behavior with multiple tabs:
        //
        // Scenario 1: Sequential registration across tabs
        // - Tab A registers => DappFence SW installed
        // - Tab B registers => No action (DappFence already controls both)
        // - Either tab registers with appSW => DappFence reloads with appSW
        // - Another tab registers with appSW => No action (combined SW already active)
        //
        // Scenario 2: Sequential registration within same tab, then second tab
        // - Tab A registers => DappFence SW installed
        // - Tab A registers with appSW => DappFence reloads with appSW
        // - Tab B registers => DappFence SW installed again
        // - Tab B registers with appSW => DappFence reloads with appSW again
        //
        await serviceWorkers[0].waitUntilClosed();
        let activationUrl = await swHelper.waitForServiceWorkerActivation(page1);
        while (!activationUrl.includes('appSW=sw_app.js')) {
            activationUrl = await swHelper.waitForServiceWorkerActivation(page1);
            console.log(
                'Waiting activationUrl...',
                activationUrl,
                !activationUrl.includes('appSW=sw_app.js')
            );
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        let activationUrl2 = await swHelper.waitForServiceWorkerActivation(page2);
        while (!activationUrl2.includes('appSW=sw_app.js')) {
            activationUrl2 = await swHelper.waitForServiceWorkerActivation(page2);
            // console.log('Waiting activationUrl2...', activationUrl2);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    } else if (testInfo.project.name.startsWith('simple-app-sw-fixed')) {
        const url = await swHelper.waitForServiceWorkerActivation(page1);
        expect(url).toContain('appSW=sw_app.js');
        const url2 = await swHelper.waitForServiceWorkerActivation(page2);
        expect(url2).toContain('appSW=sw_app.js');
    }

    await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');
    await page1.reload();
    await page1.waitForURL(/.*\/sw-api/);
    await page2.waitForURL(/.*\/sw-api/);
    return { page1, page2 };
}

test.describe('should allow normal navigation after dismissing a security block in multiple pages', () => {
    test('click on page1, navigate page2', async ({ swHelper }, testInfo) => {
        const { page1, page2 } = await beforeEach({ swHelper }, testInfo);

        // Accept all the confirmation alerts
        page1.on('dialog', async (dialog) => {
            await dialog.accept();
        });
        await page1.getByRole('button', { name: 'Remove Site Lock' }).click();
        await page1.waitForURL('/');
        await expect(page1).toHaveTitle('DappFence - Manifest Mode Example');
        await page2.goto('');
        await page2.waitForURL('/');
        await expect(page2).toHaveTitle('DappFence - Manifest Mode Example');
    });
    test('click on page2, navigate page1', async ({ swHelper }, testInfo) => {
        const { page1, page2 } = await beforeEach({ swHelper }, testInfo);

        // Accept all the confirmation alerts
        page2.on('dialog', async (dialog) => {
            await dialog.accept();
        });
        await page2.getByRole('button', { name: 'Remove Site Lock' }).click();
        await page2.waitForURL('/');
        await expect(page2).toHaveTitle('DappFence - Manifest Mode Example');
        await page1.goto('');
        await page1.waitForURL('/');
        await expect(page1).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('click on page1, reload page2', async ({ swHelper }, testInfo) => {
        const { page1, page2 } = await beforeEach({ swHelper }, testInfo);

        // Accept all the confirmation alerts
        page1.on('dialog', async (dialog) => {
            await dialog.accept();
        });
        await page1.getByRole('button', { name: 'Remove Site Lock' }).click();
        await page1.waitForURL('/');
        await expect(page1).toHaveTitle('DappFence - Manifest Mode Example');
        await page2.reload();
        await page2.waitForURL('/');
        await expect(page2).toHaveTitle('DappFence - Manifest Mode Example');
    });
    test('click on page2, reload page1', async ({ swHelper }, testInfo) => {
        const { page1, page2 } = await beforeEach({ swHelper }, testInfo);

        // Accept all the confirmation alerts
        page2.on('dialog', async (dialog) => {
            await dialog.accept();
        });
        await page2.getByRole('button', { name: 'Remove Site Lock' }).click();
        await page2.waitForURL('/');
        await expect(page2).toHaveTitle('DappFence - Manifest Mode Example');
        await page1.reload();
        await page1.waitForURL('/');
        await expect(page1).toHaveTitle('DappFence - Manifest Mode Example');
    });
});
