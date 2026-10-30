/**
 * End-to-end tests for Clear-Site-Data emergency panel.
 *
 * Chrome processes Clear-Site-Data at the network layer — when the SW's
 * inner fetch() receives the server response, AppSecurity.onclose fires synchronously
 * enough that isClosed() is true by the time the SW checks it in the same request
 * handler. Clear-Site-Data: "storage" also unregisters the SW.
 *
 * Two detection paths:
 *   1. Client side (AppSecurityWatchdog.onclose): fires when a running page receives a
 *      response with Clear-Site-Data, replacing the DOM with the emergency panel.
 *   2. SW side (appStore.isClosed()): fires on the same navigation that carries
 *      Clear-Site-Data, returning the emergency panel before content checks run.
 *      Because Clear-Site-Data also unregisters the SW, this path is only exercised
 *      from about:blank (no client context running).
 */
import { expect, test } from '../sw-fixtures';

test.describe('Clear-Site-Data: client-side detection via AppSecurityWatchdog', () => {
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

    test('Subresource fetch with Clear-Site-Data closes AppSecurityWatchdog and shows emergency panel', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '**/null.js',
                    headers: {
                        'Clear-Site-Data': '"storage"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                    },
                },
            ],
        });

        // Fetch a resource that returns Clear-Site-Data: "storage". The SW passes it
        // through unchanged (destination=""), so the header reaches the browser and
        // forces all IndexedDB connections for this origin to close.
        await page.evaluate(async () => {
            const r = await fetch('/null.js');
            await r.text();
        });

        // AppSecurityWatchdog.onclose fires and replaces the page DOM with the emergency panel.
        const heading = page.locator('h1');
        await expect(heading).toHaveText('Security Action Required', { timeout: 5000 });

        // The panel's guards must be live, not just its markup (a <script> inside
        // the panel would never run, because it is inserted through innerHTML).
        // Chrome only shows the beforeunload prompt after a user gesture.
        await heading.click();

        // Links are blocked: clicking one neither navigates nor prompts.
        const urlBefore = page.url();
        await page.evaluate(() => {
            const link = document.createElement('a');
            link.id = 'escape-link';
            link.href = '/elsewhere';
            link.textContent = 'escape';
            document.body.append(link);
        });
        await page.locator('#escape-link').click();
        await expect(heading).toHaveText('Security Action Required');
        expect(page.url()).toBe(urlBefore);

        // Reloading asks for confirmation; dismissing it keeps the panel.
        // The evaluate call doesn't settle until the prompt is answered.
        const dialogPromise = page.waitForEvent('dialog');
        const reload = page.evaluate(() => location.reload());
        const dialog = await dialogPromise;
        expect(dialog.type()).toBe('beforeunload');
        await dialog.dismiss();
        await reload;
        await expect(heading).toHaveText('Security Action Required');
    });
});
