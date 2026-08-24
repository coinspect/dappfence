/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, test } from '../sw-fixtures';

// From: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/controller
// "The property also returns null if the request is a force refresh (Shift + refresh)"
test.describe('after force reload (Ctrl-F5)', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('');
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();

        await swHelper.sendHardReload();
        await page.waitForTimeout(2000);
    });

    test('should claim control and handle navigation', async ({ page, swHelper }) => {
        await swHelper.interceptAndModifyPageContent('**/');

        // soft reload
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('Security Warning - Content Blocked');
    });

    test('should claim control but not block programmatic fetches (ajax)', async ({
        page,
        swHelper,
    }) => {
        // Programmatic fetch() calls have destination="" and are intentionally
        // skipped by DappFence. Only browser-initiated resource loads (scripts,
        // navigation) are subject to integrity verification.
        await swHelper.interceptAndModifyPageContent('**/app.js');

        await page.evaluate(async () => {
            const res = await fetch('/app.js');
            await res.text();
        });

        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await expect(page).not.toHaveURL(/.*\/sw-api/);
    });
});

// Browser limitation: Force refresh (Shift + F5) causes service worker controller to be null
// (see https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/controller)
// This may result in some automatically loaded resources bypassing the service worker during the brief period
// before the service worker claims control again via clients.claim()
test.fixme(
    'after force reload (Ctrl-F5) we may miss some automatic loading files',
    async ({ page, swHelper }) => {
        await swHelper.setServerTestParameters({ saveResponses: true });

        await page.goto('');
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();

        const pre = await swHelper.getServerResponses();
        await swHelper.interceptAndModifyPageContent('**/app.js');

        await swHelper.sendHardReload();
        await page.waitForTimeout(2000);

        const pos = await swHelper.getServerResponses();
        // JavaScript files were loaded and intercepted, but we don't get a security warning
        expect(pos.slice(pre.length).filter((x) => x.url.endsWith('.js')).length).toBeGreaterThan(
            0
        );
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    }
);
