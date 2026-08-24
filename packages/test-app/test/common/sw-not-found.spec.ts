/**
 * End-to-end tests for not-found page verification.
 *
 * The SW uses the `not-found` pathRule to map navigation to unknown URLs to
 * the app's `/404.html` manifest key. A valid 404-page body passes; any other
 * body (unknown or tampered) is blocked.
 *
 * A second describe block tests the same scenarios against a manifest that has
 * no `not-found` rule (no-not-found-manifest.json). The SW is registered fresh
 * per test by navigating to /no-not-found.html first — that page embeds the
 * alternate manifest URL, so the newly registered SW picks up the rule-free
 * config. /no-not-found.html is built with the same templateFlags as the
 * target, so the sw-capture lifecycle applies there just as it does for the
 * default index.
 */
import { expect, test, type SWHelper } from '../sw-fixtures';
import type { Page, TestInfo } from '@playwright/test';

async function activateSW(
    page: Page,
    swHelper: SWHelper,
    testInfo: TestInfo,
    url = '',
    expectedManifestUrl?: string
) {
    await page.goto(url);
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
    const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
    if (swCapture) {
        await serviceWorkers[0].waitUntilClosed();
    }
    const swScriptUrl = await swHelper.waitForServiceWorkerActivation();
    if (expectedManifestUrl) {
        const params = new URL(swScriptUrl).searchParams;
        expect(params.get('manifestUrl')).toBe(expectedManifestUrl);
    }
}

test.describe('not-found page verification', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await activateSW(page, swHelper, testInfo, '', 'integrity-manifest.json');
    });

    test('should show the 404 page when the server returns the expected 404 body', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/sw-not-found-valid',
            formula: 'replace',
            args: '404.html',
            statusCode: 404,
        });
        await page.goto('/sw-not-found-valid');
        await expect(page.getByText('Page Not Found')).toBeVisible();
    });

    test('should block navigation when the server returns an unknown body for a missing page', async ({
        page,
        baseURL,
    }) => {
        await expect(page.goto('/this-page-does-not-exist')).rejects.toThrow(
            'page.goto: net::ERR_ABORTED at ' + baseURL
        );
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });

    test('should block navigation when the 404 page body is tampered', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/sw-not-found-tampered',
            formula: 'inject',
            args: '<script>evil()</script>',
            statusCode: 404,
        });
        await expect(page.goto('/sw-not-found-tampered')).rejects.toThrow(
            'page.goto: net::ERR_ABORTED at ' + baseURL
        );
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });
});

test.describe('not-found behavior without not-found pathRule', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await activateSW(
            page,
            swHelper,
            testInfo,
            '/no-not-found.html',
            'no-not-found-manifest.json'
        );
    });

    test('should block navigation to an unknown URL when no not-found rule exists', async ({
        page,
        baseURL,
    }) => {
        await expect(page.goto('/this-page-does-not-exist')).rejects.toThrow(
            'page.goto: net::ERR_ABORTED at ' + baseURL
        );
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });

    test('should block even when server returns the correct 404 page body', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        // With the rule, this body would pass (MATCH). Without it, there is no
        // fallback key to compare against, so the SW cannot verify and must block.
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/sw-no-rule-valid-body',
            formula: 'replace',
            args: '404.html',
            statusCode: 404,
        });
        await expect(page.goto('/sw-no-rule-valid-body')).rejects.toThrow(
            'page.goto: net::ERR_ABORTED at ' + baseURL
        );
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });
});
