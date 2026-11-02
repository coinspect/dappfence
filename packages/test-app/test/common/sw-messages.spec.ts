/**
 * End-to-end tests for integrator text overrides.
 *
 * messages.html is bound to messages-manifest.json, whose signed payload
 * carries Spanish overrides for a few keys (build-config.js). The browser runs
 * with locale es-AR, so those keys show in Spanish and the rest fall back to
 * built-in English.
 *
 * The emergency panel only has the overrides if the SW sent them to the page
 * (MSG.MESSAGES, in reply to CLIENT_READY) before storage was wiped. On the
 * very first load the manifest isn't fetched yet when the page reports ready,
 * so each test reloads once the SW is active.
 *
 * `locale` alone only emulates the language for pages; the service worker
 * (which renders the warning page) still sees the process locale. On Linux,
 * Chromium takes that from LANGUAGE (it ignores --lang), so setting it makes
 * the whole browser Spanish, as for a real Spanish-speaking user.
 */
import { expect, test } from '../sw-fixtures';

test.use({
    locale: 'es-AR',
    launchOptions: { env: { ...process.env, LANGUAGE: 'es-AR', LANG: 'es_AR.UTF-8' } },
});

test.describe('signed text overrides', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('/messages.html');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();
        await page.reload();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('the emergency panel shows the signed overrides for the viewer locale', async ({
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

        await page.evaluate(async () => {
            const r = await fetch('/null.js');
            await r.text();
        });

        await expect(page.locator('h1')).toHaveText('Se requiere una acción de seguridad', {
            timeout: 5000,
        });
        await expect(page.getByText('security@example.com')).toBeVisible();
        // Not overridden: built-in English.
        await expect(page).toHaveTitle('Critical Security Notice');
    });

    test('the warning page shows the signed overrides for the viewer locale', async ({
        page,
        swHelper,
    }, testInfo) => {
        test.skip(
            testInfo.project.name.startsWith('simple-app-sw-capture'),
            'app.js is not loaded by the page in this variant'
        );
        await swHelper.interceptAndModifyPageContent('**/app.js');
        await page.goto('/messages.html');
        await page.waitForURL(/.*\/sw-api/);

        await expect(page.locator('h1')).toHaveText('Advertencia de seguridad');
        await expect(page.getByText('Contenido del archivo alterado')).toBeVisible();
        await expect(page).toHaveTitle('Security Warning - Content Blocked');
    });

    test('a page script cannot inject text with a synthetic message event', async ({
        page,
        swHelper,
    }) => {
        await page.evaluate(() => {
            navigator.serviceWorker.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'DAPPFENCE_MESSAGES',
                        overrides: { es: { 'emergency.title': 'Llamá al 555-ATTACKER' } },
                    },
                })
            );
        });
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '**/null.js',
                    headers: { 'Clear-Site-Data': '"storage"', 'Cache-Control': 'no-store' },
                },
            ],
        });
        await page.evaluate(async () => {
            await (await fetch('/null.js')).text();
        });

        await expect(page.locator('h1')).toHaveText('Se requiere una acción de seguridad', {
            timeout: 5000,
        });
    });
});
