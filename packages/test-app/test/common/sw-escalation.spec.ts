/**
 * End-to-end tests for manifest escalation in file-verifier.js.
 *
 * verifyFileWithContext escalates through three steps when a hash lookup fails
 * for unpinned clients:
 *   step 2  latestManifest — IndexedDB cache, caller-supplied
 *   step 3  getManifestHistory — stored historic manifests, newest-first
 *   step 4  fetchAndStoreManifest — force network fetch (terminal)
 *
 * Pinned clients (clientIdXManifest) skip escalation entirely — any failure
 * against the pinned manifest is a genuine violation.
 */
import { expect, type SWHelper, test } from '../sw-fixtures';
import type { Page, TestInfo } from '@playwright/test';

async function activateSW(
    { page, swHelper }: { page: Page; swHelper: SWHelper },
    testInfo: TestInfo
) {
    await page.goto('');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
    const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
    if (swCapture) {
        await serviceWorkers[0].waitUntilClosed();
    }
    await swHelper.waitForServiceWorkerActivation();
}

async function getAppVersion(page: Page): Promise<string> {
    return page.evaluate(async () => {
        const res = await fetch('/sw-api/status');
        const json = await res.json();
        return json.appVersion as string;
    });
}

// ── step 4: fresh network fetch ───────────────────────────────────────────────

test('step 4 — fresh manifest fetch resolves a deployment upgrade without blocking', async ({
    page,
    swHelper,
}, testInfo) => {
    // Install SW; install handler fetches 1.0.1 manifest → IndexedDB: [1.0.1]
    await swHelper.setVersion('1.0.1');
    await activateSW({ page, swHelper }, testInfo);

    // Deploy: switch to latest. index.html and dappfence.js have different hashes
    // between versions, so the 1.0.1 manifest will produce a MISMATCH.
    await swHelper.setVersion('latest');

    // Navigation bypasses pin → escalation:
    //   step 2: 1.0.1 manifest (IndexedDB[0]) → MISMATCH on index.html
    //   step 3: history is [1.0.1], same appVersion as latestManifest → skip
    //   step 4: fetch latest manifest from network → MATCH → pins → page loads
    const response = await page.reload();
    expect(response.fromServiceWorker()).toBeTruthy();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
});

// ── step 3: historic manifest ─────────────────────────────────────────────────

test('step 3 — historic manifest match loads page when the network manifest is unavailable', async ({
    page,
    swHelper,
}, testInfo) => {
    // Install SW at 1.0.1; IndexedDB after install: [1.0.1]
    await swHelper.setVersion('1.0.1');
    await activateSW({ page, swHelper }, testInfo);

    // Reload at latest; step-4 escalation fetches and stores latest manifest.
    // IndexedDB after reload: [latest, 1.0.1] (newest-first)
    await swHelper.setVersion('latest');
    const r1 = await page.reload();
    expect(r1.fromServiceWorker()).toBeTruthy();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    // Roll back server to 1.0.1 and block the manifest endpoint.
    // If step 4 (network fetch) were reached, it would fail → page would block.
    // Step 3 should find 1.0.1 in history first and avoid reaching step 4.
    await swHelper.setVersion('1.0.1');
    await swHelper.interceptAndModifyPageContent({
        pattern: '**/integrity-manifest.json',
        formula: 'empty',
        statusCode: 500,
    });

    // Navigation → escalation:
    //   step 2: latest manifest (IndexedDB[0]) → MISMATCH (1.0.1 content vs latest hashes)
    //   step 3: history [latest (skip, already tried), 1.0.1] → 1.0.1 MATCH → page loads
    //   step 4: never reached
    const r2 = await page.reload();
    expect(r2.fromServiceWorker()).toBeTruthy();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
});

// ── genuine tamper ────────────────────────────────────────────────────────────

test('genuine tamper blocks through all escalation steps', async ({
    page,
    swHelper,
    baseURL,
}, testInfo) => {
    await swHelper.setVersion('latest');
    await activateSW({ page, swHelper }, testInfo);

    // Tampered index.html hash matches no manifest version.
    await swHelper.interceptAndModifyPageContent({ pattern: '**/', formula: 'default' });

    // Navigation → escalation:
    //   step 2: latest manifest (IndexedDB[0]) → MISMATCH (tampered content)
    //   step 3: history has only latest (already tried) → skip
    //   step 4: fetch fresh latest manifest → same expected hash → still MISMATCH
    //   result: violation — escalation does not rescue a genuine tamper
    await expect(page.goto('')).rejects.toThrow('net::ERR_ABORTED at ' + baseURL);
    await page.waitForURL(/.*\/sw-api/);
    await expect(page.getByText('Security Warning')).toBeVisible();
});

// ── appVersion tracking ───────────────────────────────────────────────────────

test('appVersion in status reflects the manifest resolved by escalation and stabilises on re-load', async ({
    page,
    swHelper,
}, testInfo) => {
    await swHelper.setVersion('1.0.1');
    await activateSW({ page, swHelper }, testInfo);

    const version101 = await getAppVersion(page);
    expect(version101).not.toBeNull();

    // Upgrade → step-4 escalation fetches latest manifest and pins to it.
    await swHelper.setVersion('latest');
    await page.reload();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    const versionLatest = await getAppVersion(page);
    expect(versionLatest).not.toBeNull();
    // The manifest changed; the tracked appVersion must differ.
    expect(versionLatest).not.toBe(version101);

    // Second reload: step 2 now finds latest in IndexedDB → MATCH immediately.
    // appVersion must stay the same — no unnecessary escalation.
    await page.reload();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    const versionStable = await getAppVersion(page);
    expect(versionStable).toBe(versionLatest);
});

// ── tamper with history present ───────────────────────────────────────────────

test('tamper blocks even when multiple manifest versions are in history', async ({
    page,
    swHelper,
    baseURL,
}, testInfo) => {
    // Build history with both versions so step 3 has real candidates to try.
    await swHelper.setVersion('1.0.1');
    await activateSW({ page, swHelper }, testInfo);

    await swHelper.setVersion('latest');
    const r1 = await page.reload();
    expect(r1.fromServiceWorker()).toBeTruthy();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    // Tamper index.html — its hash matches neither the 1.0.1 nor the latest manifest.
    await swHelper.interceptAndModifyPageContent({ pattern: '**/', formula: 'default' });

    // Navigation → escalation:
    //   step 2: latest manifest → MISMATCH (tampered content)
    //   step 3: history [latest (skip), 1.0.1] → 1.0.1 manifest → MISMATCH (same tamper)
    //   step 4: fetch fresh latest manifest → still MISMATCH
    //   result: violation despite rich history
    await expect(page.goto('')).rejects.toThrow('net::ERR_ABORTED at ' + baseURL);
    await page.waitForURL(/.*\/sw-api/);
    await expect(page.getByText('Security Warning')).toBeVisible();
});
