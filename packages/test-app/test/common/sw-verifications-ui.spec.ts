/**
 * End-to-end tests for the `/sw-api/status` endpoint and the status UI rendered
 * by `test-app/assets/app.js`. These lock in the contract between the SW's
 * `verificationResultsStore`, the API handler, and the dev-UI drawer, so that
 * downstream refactors to the store's internal shape don't silently regress
 * either side.
 */
import { expect, test } from '../sw-fixtures';
import type { Page } from '@playwright/test';

type StatusRow = {
    status: string;
    timestamp: string | number;
    fileKey: string;
    reason?: string;
    expectedHashes?: string[];
    actualHash?: string;
};

type StatusBody = {
    appVersion: string | null;
    verificationResults: StatusRow[];
    stats: {
        trustedFiles: number;
        totalVerifications: number;
        totalBlocks: number;
        activeBlocks: number;
    };
};

async function fetchStatus(page: Page): Promise<StatusBody> {
    return page.evaluate(async () => {
        const response = await fetch('/sw-api/status');
        return response.json();
    });
}

async function loadThroughActiveSW(
    page: Page,
    swHelper: { waitForServiceWorkerActivation: (p?: Page) => Promise<string> }
) {
    await page.goto('');
    await swHelper.waitForServiceWorkerActivation();
    await page.reload();
    await page.waitForLoadState('networkidle');
}

test('/sw-api/status returns verificationResults as an array of rows', async ({
    page,
    swHelper,
}) => {
    await loadThroughActiveSW(page, swHelper);

    const body = await fetchStatus(page);

    expect(Array.isArray(body.verificationResults)).toBe(true);
    expect(body.stats.totalVerifications).toBe(body.verificationResults.length);
    expect(body.verificationResults.length).toBeGreaterThan(0);

    for (const row of body.verificationResults) {
        expect(typeof row.status).toBe('string');
        expect(typeof row.fileKey).toBe('string');
        expect(['string', 'number']).toContain(typeof row.timestamp);
        expect(new Date(row.timestamp).getTime()).not.toBeNaN();
    }
});

test('/sw-api/status records MATCH outcomes for trusted files', async ({ page, swHelper }) => {
    await loadThroughActiveSW(page, swHelper);

    const body = await fetchStatus(page);
    const matches = body.verificationResults.filter((r) => r.status === 'MATCH');
    expect(matches.length).toBeGreaterThan(0);
});

test('UI drawer renders Trusted manifest status card with Total verifications stat', async ({
    page,
    swHelper,
}, testInfo) => {
    test.skip(
        testInfo.project.name.startsWith('simple-app-sw-capture'),
        'sw-capture reloads the SW mid-page; UI render contract exercised by other projects'
    );
    await loadThroughActiveSW(page, swHelper);

    const card = page.getByText('📋 Trusted manifest status');
    await expect(card).toBeVisible();

    const totalLabel = page.getByText('Total verifications');
    await expect(totalLabel).toBeVisible();

    const totalValue = await totalLabel.locator('..').locator('.stat__value').innerText();
    expect(Number(totalValue)).toBeGreaterThan(0);
});

test('UI Verifications drawer renders file rows reflecting /sw-api/status', async ({
    page,
    swHelper,
}, testInfo) => {
    test.skip(
        testInfo.project.name.startsWith('simple-app-sw-capture'),
        'sw-capture reloads the SW mid-page; UI render contract exercised by other projects'
    );
    await loadThroughActiveSW(page, swHelper);

    const body = await fetchStatus(page);
    if (body.verificationResults.length === 0) {
        test.skip();
        return;
    }

    const verificationsSummary = page.getByText('🔍 Verifications');
    await expect(verificationsSummary).toBeVisible();

    const details = verificationsSummary.locator('..');
    await details.click();

    const fileRows = details.locator('.file-row');
    const rendered = await fileRows.count();
    expect(rendered).toBe(Math.min(body.verificationResults.length, 100));
});
