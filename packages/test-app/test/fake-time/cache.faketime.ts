import { expect, test, SWHelper } from '../sw-fixtures';
import type { Page, TestInfo } from '@playwright/test';

test.setTimeout(20 * 60 * 1000); // 20 minutes

function formatTimestampDelta(start: number, end: number) {
    const deltaSecs = Math.floor((end - start) / 1000);
    const hours = Math.floor(deltaSecs / 3600);
    const minutes = Math.floor((deltaSecs % 3600) / 60);
    const secs = deltaSecs % 60;
    const format = (n: number) => n.toString().padStart(2, '0');
    return `${format(hours)}:${format(minutes)}:${format(secs)}`;
}

test('measure cache expiration time for DappFence reload with fake time acceleration', async ({
    page,
    swHelper,
    baseURL,
}) => {
    await swHelper.setServerTestParameters({
        appName: 'simple-app-dev',
        appVersion: 'latest',
        saveResponses: true,
        responseHeaders: [
            {
                match: '*',
                headers: {
                    'Cache-Control': 'max-age=3600000', // 1000 hours
                },
            },
        ],
    });

    await page.goto('');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation(page);

    const prevRequests = await swHelper.getServerResponses();

    const DELAY = 10 * 1000; // ms we wait between page reloads
    const ADVANCE = 4 * 60; // the pace at which the clock advances inside the browser

    await swHelper.setFakeTime(`+0 x${ADVANCE}`);

    const startDate = await page.evaluate(() => Date.now());
    let requests = [];
    let endDate = startDate;
    let i = 0;
    while (true) {
        // Log iteration and time while libfaketime speeds up the page's clock independently of Playwright's
        console.log(
            'Estimated delta',
            formatTimestampDelta(0, i++ * DELAY * ADVANCE),
            'Browser delta',
            formatTimestampDelta(startDate, endDate),
            'Current Time',
            new Date().toTimeString().slice(0, 8)
        );
        // OBS: libfaketime affects the way page.waitForTimeout() works.
        await new Promise((resolve) => setTimeout(resolve, DELAY));

        requests = (await swHelper.getServerResponses())
            .slice(prevRequests.length)
            .filter((x) => x.url.includes('dappfence'));
        if (requests.length !== 0) {
            break;
        }

        try {
            endDate = await page.evaluate(() => Date.now());
        } catch (err) {
            console.log('Error evaluating Date.now():', err.toString());
        }

        page.reload({ waitUntil: 'commit' }).catch((err) => console.log(err.toString()));
    }
    requests = (await swHelper.getServerResponses())
        .slice(prevRequests.length)
        .filter((x) => x.url !== baseURL);
    console.log();
    console.log();
    console.log(
        'Time until DappFence was fetched again:',
        formatTimestampDelta(startDate, endDate),
        '- What we fetched:',
        requests.map((x) => x.url)
    );
});

test.describe('24hs limit', () => {
    test('should maintain DappFence protection within 24 hour window despite cache expiration', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app-dev',
            appVersion: 'latest',
            saveResponses: true,
            responseHeaders: [
                {
                    match: '*dappfence.js',
                    headers: {
                        'Cache-Control': 'max-age=3600000', // 1000 hours
                    },
                },
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=36000', // 10 hours
                    },
                },
            ],
        });

        await page.goto('');
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation(page);

        // 'remap' with {file} actually serves null.js bytes; 'replace' is not a real
        // formula and silently falls back to 'default' (just prepends `// modified\n`).
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/dappfence.js',
            formula: 'remap',
            args: { file: 'null.js' },
        });

        await swHelper.setFakeTime(`+9h`);

        // The null.js file that replaces dappfence.js is not loaded yet, everything comes from the cache.
        await page.reload();
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');

        // Dappfence is still active and protecting us, cache expired
        await swHelper.setFakeTime(`+23.9h`);
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);
    });

    test('should lose DappFence protection after 24 hour threshold when compromised script is served', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app-dev',
            appVersion: 'latest',
            saveResponses: true,
            responseHeaders: [
                {
                    match: '*dappfence.js',
                    headers: {
                        'Cache-Control': 'max-age=3600000', // 1000 hours
                    },
                },
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=108000', // 30 hours
                    },
                },
            ],
        });

        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation(page);

        // 'remap' with {file} actually serves the target file's content; 'replace'
        // is not a real formula and silently falls back to 'default' which just
        // prepends `// modified\n`.
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/dappfence.js',
            formula: 'remap',
            args: { file: 'null.js' },
        });

        // Register the SW-context NULL listener BEFORE any attack action. null.js logs
        // NULL from the SW global scope (not page), so we need the fixture's SW-message
        // channel (page.on('console') wouldn't see it).
        const nullObservedPromise = swHelper.waitForServiceWorkerMessage('NULL');

        await swHelper.setFakeTime(`+9h`);

        // The null.js file that replaces dappfence.js is not loaded yet, everything comes from the cache.
        await page.reload();
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        // after 25hs automatic reload loads `null.js`
        await swHelper.setFakeTime(`+25h`);
        await page.reload();
        await page.waitForURL('/');
        await page.waitForTimeout(500);
        // give null an opportunity to activate
        await page.goto('about:blank');
        await page.waitForTimeout(500);
        await page.goto('/');
        await page.waitForURL('/');

        // Now when we reload, we are not protected anymore
        await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');
        await swHelper.setFakeTime(`+31h x600`);
        await page.reload();
        await page.waitForURL('/');
        // Default 5s matcher timeout is a hair too short for the post-Soft-Update parse
        // under +31h x600 fake-time churn (seen ~6s real-time); 60s is defensive headroom.
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example', { timeout: 60_000 });

        // Wait for null.js's IIFE to log NULL in SW context. Observed via the fixture's
        // waitForServiceWorkerMessage (which listens on SW consoles, not page console).
        await nullObservedPromise;
    });

    // Reproducible trigger for Chromium's automatic 24h Service Worker Soft Update.
    // The sequence below is the only one that reliably fires the update in Chromium
    // 148 under faketime; keep it as a reference and as a regression guard against
    // the Soft Update attack path (origin-level SW bytes swap).
    //
    // Trigger pattern (from service_worker_version.cc):
    //   - Soft Update is scheduled when the SW is stale (>24h since last_update_check)
    //     AND the worker becomes idle (30s inactivity) OR a navigation + 1s delay fires.
    //   - Keeping the SW busy with repeated fetches BLOCKS the idle trigger, so we do
    //     exactly one wake-up fetch then poll server-side (which never touches the SW).
    //
    // Steps:
    //   1. Install SW normally.
    //   2. Swap the dappfence.js bytes on the server for sw_app.js (a proper SW with
    //      skipWaiting + clients.claim, so it takes over on install). Simulates an
    //      origin compromise.
    //   3. setFakeTime +25h past the 24h threshold.
    //   4. One in-page fetch to wake the SW.
    //   5. Poll server-side for the SW refetch.
    //   6. 10s settle delay for install + activation to complete.
    //   7. Behavioral probe: fetch /sw-api/status — DappFence returns 200; sw_app.js
    //      has no handler, so it falls through to the server which 404s. 404 means
    //      the attack succeeded (new SW took over).
    //
    // Current expected result: attack SUCCEEDS. DappFence has no mechanism to block
    // the 24h Soft Update at the browser layer — SW main scripts bypass CSP checks
    // (crbug.com/40083537) and the update job is Chromium-internal. If this test
    // ever starts failing on the final assertion (dappfenceStillInControl === true),
    // either Chromium has closed the gap OR DappFence has grown a defense; either
    // way, worth revisiting.
    test('Chromium 24h Soft Update: compromised SW bytes take over (no DappFence defense)', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app-dev',
            appVersion: 'latest',
            saveResponses: true,
            responseHeaders: [
                { match: '*dappfence.js', headers: { 'Cache-Control': 'max-age=3600000' } },
                { match: '*', headers: { 'Cache-Control': 'max-age=108000' } },
            ],
        });

        await page.goto('');
        await swHelper.waitForServiceWorkerActivation(page);
        // Setup reload: the initial navigation above happened before the SW was active,
        // so the current page isn't SW-controlled yet. Reload once so subsequent fetches
        // go through the SW event loop — required for the wake-up fetch below to count
        // as SW activity (and for the idle→Soft Update trigger to fire).
        await page.reload();
        await page.waitForURL('/');

        await swHelper.interceptAndModifyPageContent({
            pattern: '**/dappfence.js',
            formula: 'remap',
            args: { file: 'sw_app.js' },
        });

        const requestsBefore = (await swHelper.getServerResponses()).length;

        await swHelper.setFakeTime('+25h');
        await page.evaluate(() => fetch('/null.js'));

        const MAX_WAIT_MS = 60_000; // 30s idle + 1s update delay + margin
        const POLL_MS = 500;
        const startWait = Date.now();
        let refetched = false;
        while (!refetched && Date.now() - startWait < MAX_WAIT_MS) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            const requests = await swHelper.getServerResponses();
            const newRequests = requests.slice(requestsBefore);
            refetched = newRequests.some((r) => r.url.includes('/dappfence.js?'));
        }
        const requests = await swHelper.getServerResponses();
        const swRefetches = requests
            .slice(requestsBefore)
            .filter((r) => r.url.includes('/dappfence.js?'));

        // Give the install/activation race time to settle before probing. Soft Update
        // fetch lands within ~0.5-1s but the new SW may still be in installing/waiting;
        // 10s real-time is enough to activate (or demonstrate it never will).
        await new Promise((resolve) => setTimeout(resolve, 10_000));

        // Behavioral probe: who's handling SW fetches NOW? DappFence SW responds to
        // /sw-api/status with 200; sw_app.js has no handler, so it falls through to
        // the server which 404s. 200 → DappFence still in control; false → attack
        // succeeded.
        const dappfenceStillInControl = await page.evaluate(() =>
            fetch('/sw-api/status')
                .then((r) => r.ok)
                .catch(() => false)
        );
        console.log(
            `[soft-update] final: swRefetches=${swRefetches.length} dappfenceStillInControl=${dappfenceStillInControl} waitSec=${((Date.now() - startWait) / 1000).toFixed(1)}`
        );

        // Chromium DID issue the Soft Update fetch — confirms the 24h timer fired.
        expect(
            swRefetches.length,
            `expected ≥1 SW refetch after +25h — Soft Update should fire`
        ).toBeGreaterThan(0);

        // The attack SUCCEEDED: new SW took over. If this ever starts asserting
        // the opposite, Chromium has closed crbug.com/40083537 or DappFence has
        // grown a defense against origin-level SW bytes swap.
        expect(
            dappfenceStillInControl,
            `attack should have SUCCEEDED (24h Soft Update is not blockable by DappFence); dappfenceStillInControl=${dappfenceStillInControl}`
        ).toBe(false);
    });
});

/*
 * Child SW cache behavior across Chromium's 24h soft-update boundary.
 *
 * ─── Chromium cache logic for SW update checks ─────────────────────────
 *
 * DappFence registers its SW with `updateViaCache: 'all'` (see
 * packages/dappfence/src/client/sw-registration.js:182, 292, 305).
 *
 * Cache decision lives in Chromium at
 *   content/browser/service_worker/service_worker_loader_helpers.cc
 *   → ShouldValidateBrowserCacheForScript(is_main_script, force_bypass_cache,
 *      cache_mode, time_since_last_check)
 * called from
 *   content/browser/service_worker/service_worker_single_script_update_checker.cc
 *   → ServiceWorkerSingleScriptUpdateChecker ctor.
 *
 * Sets net::LOAD_VALIDATE_CACHE (conditional GET → server hit even on 304)
 * when ANY of:
 *   (A) ShouldBypassCacheDueToUpdateViaCache: cache_mode == 'none', OR
 *       (cache_mode == 'imports' AND is_main_script).
 *   (B) time_since_last_check > kServiceWorkerScriptMaxCacheAge (24h).
 *       Applies to BOTH main script and imports.
 *   (C) force_bypass_cache (DevTools).
 *
 * With updateViaCache='all': (A) never fires. (B) fires at 24h for both main
 * and imports → revalidation requests hit the server for dappfence.js AND
 * sw_app.js on the next update check.
 *
 * ─── Why we simulate the SW kill instead of waiting for idle ──────────
 *
 * Playwright auto-attaches a CDP session to every ServiceWorker target in
 * the context (needed for its Worker object + console events — we rely on
 * this for waitForServiceWorkerMessage etc.). Chromium's
 *   content/browser/service_worker/embedded_worker_instance.cc
 *   → StopIfNotAttachedToDevTools()
 * explicitly SKIPS idle termination when ANY debugger is attached ("Service
 * Worker termination by a timeout timer was canceled because DevTools is
 * attached"). So under Playwright, SWs don't idle-terminate no matter how
 * long the page sits on about:blank or how aggressive we make faketime.
 * Verified both by Chromium source read and by direct testing.
 *
 * The orthogonal note: the Soft Update check itself (whether to revalidate
 * the SW script) is NOT affected by devtools attachment. It's triggered by
 * `navigation + 1s delay` or `SW idle for 30s` in service_worker_version.cc.
 * Under Playwright the "navigation + 1s" path still fires normally — so the
 * 24h revalidation at +25h is observable without any workaround.
 *
 * To test cold-restart cache behavior (which does require a dead SW) we
 * simulate the kill:
 *   1. page.goto('about:blank')  — drop page JS context (kills the 15s
 *      REPORT_EVENTS ping that would otherwise keep the SW busy)
 *   2. Wait ~20s real-time       — > one ping interval, so any in-flight
 *      REPORT_EVENTS message drains and the SW is genuinely idle
 *   3. CDP ServiceWorker.stopWorker — maps to Chromium's Stop() path,
 *      bypasses the devtools-attached inhibition
 *   4. Await CDP stopped confirmation
 * Next navigation then cold-starts the SW from stored bytes, same as a
 * natural idle-terminated SW would.
 *
 *
 * ─── Per-checkpoint expectations (verified empirically) ───────────────
 *
 *   Plain-reloads mode (SW stays alive):
 *     +9h, +23h:   no update check (<24h stale). dappfence=0, swApp=0.
 *     +25h:        24h stale → LOAD_VALIDATE_CACHE for main + imports.
 *                  dappfence=1 (active SW URL revalidation). swApp=1.
 *
 *   Simulated-kill mode (CDP stopWorker between steps):
 *     +9h, +23h:   cold-restart only. scriptRuns delta=1.
 *                  dappfence=0, swApp=0, installs=0  — child SW came
 *                  from SW script storage, not server, no new install.
 *     +25h:        cold-restart PLUS Soft Update revalidation.
 *                  scriptRuns delta=1. dappfence=1 (active URL).
 *
 * Capture-mode note: the "two SWs" (dappfence.js and
 * dappfence.js?appSW=sw_app.js) end as one active registration after SW #2
 * replaces SW #1 in the capture dance. Soft Update only revalidates the
 * active URL → expected dappfence refetch is 1, same as fixed.
 */
test.describe('child SW stays HTTP-cached until Chromium soft-update past 24h', () => {
    const CACHE_10_DAYS_SECONDS = 10 * 24 * 3600;
    const MAIN_SW_START_MESSAGE = 'Initializing service worker protection';
    const CHILD_SW_INITIAL_MESSAGE = 'CHILD SERVICE WORKER ACTIVE';
    const CHILD_SW_CACHE_HEADERS = [
        {
            match: '*dappfence.js',
            headers: { 'Cache-Control': `max-age=${CACHE_10_DAYS_SECONDS}` },
        },
        { match: '*sw_app.js', headers: { 'Cache-Control': `max-age=${CACHE_10_DAYS_SECONDS}` } },
        { match: '*', headers: { 'Cache-Control': 'max-age=108000' } },
    ];

    async function getTestHelpers(page: Page, swHelper: SWHelper, testInfo: TestInfo) {
        const initialSetup = async (app: string) => {
            const env = testInfo.project.name.replace(/^fake-time-/, '');
            await swHelper.setServerTestParameters({
                appName: `${app}-${env}`,
                appVersion: 'latest',
                saveResponses: true,
                responseHeaders: CHILD_SW_CACHE_HEADERS,
            });
            const childLoadPromise = swHelper.waitForServiceWorkerMessage(CHILD_SW_INITIAL_MESSAGE);
            await page.goto('');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            await swHelper.waitForServiceWorkerActivation(page);
            await childLoadPromise;
        };
        const reload = async (timeOffset: string) => {
            await swHelper.setFakeTime(timeOffset);
            await page.goto('');
            await page.waitForURL('/');
        };

        const simulateSWKill = async () => {
            // stop client timers
            await page.goto('about:blank');
            // simulate chrome timeout
            // await new Promise((resolve) => setTimeout(resolve, 20_000));
            // kill the server using dev tools
            await swHelper.killAllServiceWorkers(page);
        };

        const getCounters = async () => {
            const responses = await swHelper.getServerResponses();
            const countUrl = (needle: string) =>
                responses.filter((r) => r.url.includes(needle)).length;
            return {
                dappfence: countUrl('/dappfence.js'),
                swApp: countUrl('/sw_app.js'),
                responses: responses
                    .map((r) => r.url)
                    .filter((r) => ['dappfence', 'sw_app'].some((x) => r.includes(x))),
            };
        };
        return {
            initialSetup,
            getCounters,
            simulateSWKill,
            reload,
        };
    }

    ['simple-app-sw-fixed', 'simple-app-sw-capture'].forEach((app) => {
        test(`${app}: plain reloads keep SW alive; +25h soft-update refetches`, async ({
            page,
            swHelper,
        }, testInfo) => {
            const { initialSetup, reload, getCounters } = await getTestHelpers(
                page,
                swHelper,
                testInfo
            );

            await initialSetup(app);
            const initial = await getCounters();
            expect(initial.dappfence).toBe(app === 'simple-app-sw-fixed' ? 2 : 3);
            // importScript(childSW) will populate the cache and our full file hash check uses that cache (there are no extre fetch)
            expect(initial.swApp).toBe(1);

            // Soft update does the fetch but doesn't do anything if the file didn't changed.
            await swHelper.interceptAndModifyPageContent('**/dappfence.js');

            await reload('+9h');
            const c9 = await getCounters();
            expect(c9.dappfence).toBe(initial.dappfence);
            expect(c9.swApp).toBe(initial.swApp);

            await reload('+23h');
            const c23 = await getCounters();
            expect(c23.dappfence).toBe(initial.dappfence);
            expect(c23.swApp).toBe(initial.swApp);

            const childLoadPromise25 =
                swHelper.waitForServiceWorkerMessage(CHILD_SW_INITIAL_MESSAGE);
            await reload('+25h');
            await childLoadPromise25;
            const c25 = await getCounters();
            expect(c25.dappfence).toBe(initial.dappfence + 1);
            // Even in this case appSW is taken from the cache (or even not reloaded)
            expect(c25.swApp).toBe(initial.swApp);
        });

        test(`${app}: simulated SW kill between steps; cold-restart from storage`, async ({
            page,
            swHelper,
        }, testInfo) => {
            const { initialSetup, simulateSWKill, reload, getCounters } = await getTestHelpers(
                page,
                swHelper,
                testInfo
            );

            await initialSetup(app);
            const initial = await getCounters();
            expect(initial.dappfence).toBe(app === 'simple-app-sw-fixed' ? 2 : 3);
            expect(initial.swApp).toBe(1);
            await simulateSWKill();

            // Soft update does the fetch but doesn't do anything if the file didn't changed.
            await swHelper.interceptAndModifyPageContent('**/dappfence.js');

            const mainSWInitPromise9 = swHelper.waitForServiceWorkerMessage(MAIN_SW_START_MESSAGE);
            await reload('+9h');
            await mainSWInitPromise9;
            const c9 = await getCounters();
            expect(c9.dappfence).toBe(initial.dappfence);
            expect(c9.swApp).toBe(initial.swApp);
            await simulateSWKill();

            const mainSWInitPromise23 = swHelper.waitForServiceWorkerMessage(MAIN_SW_START_MESSAGE);
            await reload('+23h');
            await mainSWInitPromise23;
            const c23 = await getCounters();
            expect(c23.dappfence).toBe(initial.dappfence);
            expect(c23.swApp).toBe(initial.swApp);
            await simulateSWKill();

            const mainSWInitPromise25 = swHelper.waitForServiceWorkerMessage(MAIN_SW_START_MESSAGE);
            const childLoadPromise25 =
                swHelper.waitForServiceWorkerMessage(CHILD_SW_INITIAL_MESSAGE);

            await reload('+25h');
            await mainSWInitPromise25;

            // in Playwright even after a soft update the V2 never get activated
            await simulateSWKill();
            await childLoadPromise25;

            const c25 = await getCounters();
            expect(c25.dappfence).toBe(initial.dappfence + 1);
            // Even in this case appSW is taken from the cache (or even not reloaded)
            expect(c25.swApp).toBe(initial.swApp);
        });
    });
});
