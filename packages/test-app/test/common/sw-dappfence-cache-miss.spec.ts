/**
 * Reproduces the ERR_CACHE_MISS DevTools entry that appears on first load
 * after a dev-server restart when the SW re-intercepts /dappfence.js.
 *
 * The SW's prepareRequest performs a no-cors → cors CORS upgrade (needed so
 * the SW can read the body and hash it for integrity verification). The
 * rebuilt Request is served out of a different HTTP cache partition than the
 * one the browser populated from the original <script> tag, producing a
 * cache-miss in the Network panel. The outer fetch still falls through to
 * the network, so the page loads — but the red entry is visible.
 */
import { expect, test } from '../sw-fixtures';

test.describe('SW intercept of /dappfence.js', () => {
    test('does not produce ERR_CACHE_MISS on reload', async ({ page, swHelper }) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();

        const failures: { url: string; errorText: string }[] = [];
        page.on('requestfailed', (req) => {
            failures.push({
                url: req.url(),
                errorText: req.failure()?.errorText ?? '',
            });
        });

        await page.reload();

        const dappfenceCacheMisses = failures.filter(
            (f) => f.url.includes('/dappfence.js') && f.errorText.includes('ERR_CACHE_MISS')
        );
        expect(
            dappfenceCacheMisses,
            failures.map((f) => `${f.errorText} ${f.url}`).join('\n') || 'no failures'
        ).toEqual([]);
    });
});
