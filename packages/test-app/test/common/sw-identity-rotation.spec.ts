import { expect, test } from '../sw-fixtures';
import type { Page } from '@playwright/test';

async function readIDB<T = unknown>(page: Page, key: string): Promise<T | undefined> {
    return page.evaluate((k) => {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('AppSecurity', 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction(['data'], 'readonly');
                const getReq = tx.objectStore('data').get(k);
                getReq.onsuccess = () => resolve(getReq.result);
                getReq.onerror = () => reject(getReq.error);
            };
        });
    }, key) as Promise<T | undefined>;
}

type BlockRecord = {
    status: string;
    reason?: string;
    expectedHashes?: string[];
    actualHash?: string;
};

async function readActiveBlocks(page: Page): Promise<BlockRecord[]> {
    const ids = (await readIDB<string[]>(page, 'active-block-ids')) ?? [];
    const blocks = (await readIDB<Record<string, BlockRecord>>(page, 'blocks')) ?? {};
    return ids.map((id) => blocks[id]).filter(Boolean);
}

async function waitForAnchoredIdentity(page: Page, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const anchor = await readIDB<{ identity?: string }>(page, 'active-identity');
        if (anchor?.identity) {
            return;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for active-identity to be anchored');
}

async function waitForActiveBlock(page: Page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const blocks = await readActiveBlocks(page);
        if (blocks.length > 0) {
            return blocks;
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for an active block');
}

test('SIGNER_CHANGED when navigating from signer A to signer B', async ({ page, swHelper }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation();
    await waitForAnchoredIdentity(page);

    await page.goto('/signer-b.html');
    const [block] = await waitForActiveBlock(page);
    expect(block.status).toBe('MANIFEST_UNTRUSTED');
    expect(block.reason).toBe('SIGNER_CHANGED');
    await page.reload();
    await page.waitForURL(/.*\/sw-api\/security-warning/);
});

test('Remove Site Lock accepts rotation and lets signer B load normally', async ({
    page,
    swHelper,
}) => {
    await page.goto('/');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation();
    await waitForAnchoredIdentity(page);

    await page.goto('/signer-b.html').catch(() => {});
    await waitForActiveBlock(page);

    page.on('dialog', async (dialog) => {
        await dialog.accept();
    });
    const unblock = page.getByRole('button', { name: 'Remove Site Lock' });
    await unblock.waitFor({ state: 'visible', timeout: 10000 });
    await unblock.click();

    await page.goto('/signer-b.html').catch(() => {});
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
});

test('revokeManifests flag wipes stored manifest history', async ({ page, swHelper }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation();
    await waitForAnchoredIdentity(page);

    const before = (await readIDB<unknown[]>(page, 'trusted-manifest')) ?? [];
    expect(before.length).toBeGreaterThanOrEqual(1);

    await page.goto('/revoke.html');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation();

    const after = (await readIDB<unknown[]>(page, 'trusted-manifest')) ?? [];
    expect(after).toHaveLength(1);
});
