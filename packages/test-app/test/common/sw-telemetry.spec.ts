/*
 * End-to-end telemetry pipeline.
 *
 * telemetry.html uses telemetry-manifest.json (PROTECTED mode) which declares
 *   telemetry: { eventsEndpoint: '/capture/events', logsEndpoint: '/capture/logs' }
 * and also carries data-events-endpoint="/capture/events-config" on the dappfence
 * script tag (via templateFlags). Both are set so the SW must prefer the
 * manifest-sourced URL — manifest > config fallback.
 *
 * Tampering a subresource triggers a FILE_UNTRUSTED verdict → batched → POSTed
 * to /capture/events. Tampering the manifest triggers MANIFEST_UNTRUSTED on
 * manifest re-fetch (the cached manifest still supplies the endpoint). The
 * dev server's /capture/* sink records POST bodies; the test polls
 * /api/test-responses to observe what landed.
 *
 * The 500-survival test is intentionally observational — it measures how long
 * the SW stays alive under persistent send failures, both with foreground
 * activity and with the tab navigated away. No tight assertions on duration.
 */
import { expect, test } from '../sw-fixtures';
import type { Page } from '@playwright/test';
import type { SWHelper, ServiceWorkerWithClose } from '../sw-fixtures';

async function readStore(page: Page, storeName, predicate = null, { timeout = 5_000 } = {}) {
    const doRead = () =>
        page.evaluate((name) => {
            return new Promise((resolve, reject) => {
                const open = indexedDB.open('AppSecurity');
                open.onsuccess = () => {
                    const db = open.result;
                    const req = db.transaction(name, 'readonly').objectStore(name).getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                };
                open.onerror = () => reject(open.error);
            });
        }, storeName);

    if (!predicate) {
        return doRead();
    }
    let rows = [];
    await expect
        .poll(
            async () => {
                rows = await doRead();
                return predicate(rows);
            },
            { timeout }
        )
        .toBe(true);
    return rows;
}

function expectValidShape(telemetryPost) {
    expect(typeof telemetryPost.appVersion).toBe('string');
    expect(telemetryPost.appVersion.length).toBeGreaterThan(0);
    expect(typeof telemetryPost.installationTime).toBe('number');
    expect(telemetryPost.installationTime).toBeGreaterThan(0);
    expect(telemetryPost.origin).toMatch(/^https?:\/\//);
    expect(telemetryPost.userAgent).toBeTruthy();
    expect(telemetryPost.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
}

function expectHashMismatchEvent(event) {
    expect(event).toBeDefined();
    expect(event?.reason).toBe('HASH_MISMATCH');
    expect(event?.expectedHashes?.length).toBeGreaterThan(0);
    expect(event?.actualHash).toBeTruthy();
    expect(event?.occurrenceCount).toBeGreaterThanOrEqual(1);
}

async function waitForCaptures(
    swHelper: SWHelper,
    endpointPath,
    predicate = (p) => p.length >= 1,
    { timeout = 10_000 } = {}
) {
    let telemetryPosts = [];
    await expect
        .poll(
            async () => {
                telemetryPosts = await listCapturesAt(swHelper, endpointPath);
                return predicate(telemetryPosts);
            },
            { timeout }
        )
        .toBe(true);
    return telemetryPosts;
}

async function listCapturesAt(swHelper: SWHelper, endpointPath) {
    const entries = await swHelper.getServerResponses();
    return entries
        .filter((e) => e.result === 'capture' && e.requestPath === endpointPath && e.body)
        .map((e) => ({
            ...JSON.parse(e.body),
            receivedAt: e.receivedAt,
            statusCode: e.statusCode,
        }));
}

test.describe('telemetry pipeline', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await swHelper.setServerTestParameters({ saveResponses: true });
        await page.goto('/telemetry.html');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('tampered subresource triggers FILE_UNTRUSTED POST at the manifest events endpoint', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: { pattern: '**/dappfence.js', formula: 'default' },
        });
        await page.goto('/telemetry.html');
        await page.waitForURL(/.*\/sw-api/);

        const telemetryPosts = await waitForCaptures(swHelper, '/capture/events', (posts) =>
            posts.some((p) =>
                p.events.some((e) => e.status === 'FILE_UNTRUSTED' && e.fileKey === '/dappfence.js')
            )
        );
        telemetryPosts.forEach(expectValidShape);

        const tamperedEvent = telemetryPosts
            .flatMap((e) => e.events)
            .find((e) => e.status === 'FILE_UNTRUSTED' && e.fileKey === '/dappfence.js');
        expectHashMismatchEvent(tamperedEvent);

        const configHits = await listCapturesAt(swHelper, '/capture/events-config');
        expect(configHits).toEqual([]);
    });

    test('tampered manifest reports MANIFEST_UNTRUSTED using the cached manifest URL', async ({
        page,
        swHelper,
    }) => {
        test.setTimeout(30_000);
        // Tamper both a subresource (so the verifier escalates) and the
        // manifest (so the re-fetch fails signature verification). The cached
        // manifest supplies the telemetry URL; the re-fetched tampered manifest
        // produces the MANIFEST_UNTRUSTED verdict.
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: [
                { pattern: '**/dappfence.js', formula: 'default' },
                { pattern: '**/telemetry-manifest.json', formula: 'default' },
            ],
        });
        await page.goto('/telemetry.html');
        await page.waitForURL(/.*\/sw-api/);

        await waitForCaptures(
            swHelper,
            '/capture/events',
            (ps) => ps.some((p) => p.events.some((e) => e.status === 'MANIFEST_UNTRUSTED')),
            { timeout: 10_000 }
        );
    });

    test('priority (violation) short-circuits the ceiling and ships quickly', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: { pattern: '**/jquery-3.7.1.min.js', formula: 'default' },
        });
        const navStart = Date.now();
        await page.goto('/telemetry.html');
        await page.waitForURL(/.*\/sw-api/);

        await waitForCaptures(swHelper, '/capture/events');
        const elapsed = Date.now() - navStart;

        // Priority bypass: ship on next tick instead of waiting the full
        // CEILING_MS=3000. Generous for CI load — well under 10s is enough to
        // confirm we aren't hitting the ceiling path.
        expect(elapsed).toBeLessThan(10_000);
    });
});

test.describe('telemetry pipeline (REPORTING mode)', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('/telemetry-reporting.html');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('tampered subresource ships FILE_UNTRUSTED without redirecting to warning', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: { pattern: '**/dappfence.js', formula: 'default' },
        });
        await page.goto('/telemetry-reporting.html');
        // REPORTING mode: no redirect to the warning page.
        await expect(page).toHaveURL(/\/telemetry-reporting\.html/);

        const telemetryPosts = await waitForCaptures(
            swHelper,
            '/capture/events-reporting',
            (posts) =>
                posts.some((p) =>
                    p.events.some(
                        (e) => e.status === 'FILE_UNTRUSTED' && e.fileKey === '/dappfence.js'
                    )
                )
        );
        telemetryPosts.forEach(expectValidShape);

        const tamperedEvent = telemetryPosts
            .flatMap((p) => p.events)
            .find((e) => e.status === 'FILE_UNTRUSTED' && e.fileKey === '/dappfence.js');
        expectHashMismatchEvent(tamperedEvent);

        const configHits = await listCapturesAt(swHelper, '/capture/events-config-reporting');
        expect(configHits).toEqual([]);
    });

    test('repeated violation across tabs accumulates occurrenceCount', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: { pattern: '**/dappfence.js', formula: 'default' },
        });
        await page.goto('/telemetry-reporting.html');
        await expect(page).toHaveURL(/\/telemetry-reporting\.html/);

        // Second tab hits the same tampered file. Dedup key excludes clientId,
        // so N tabs collapse into events whose occurrenceCount summed is ≥ N.
        const page2 = await swHelper.newPage('telemetry-tab-2');
        await page2.goto('/telemetry-reporting.html');
        await expect(page2).toHaveURL(/\/telemetry-reporting\.html/);

        await waitForCaptures(
            swHelper,
            '/capture/events-reporting',
            (ps) => {
                const total = ps
                    .flatMap((env) => env.events)
                    .filter((e) => e.status === 'FILE_UNTRUSTED' && e.fileKey === '/dappfence.js')
                    .reduce((sum, e) => sum + e.occurrenceCount, 0);
                return total >= 2;
            },
            { timeout: 15_000 }
        );
    });
});

// Standalone — doesn't share the pipeline describe's beforeEach because the
// intercept must be set BEFORE the SW first registers and fetches the manifest.
test('events ship to config URL when no manifest is cached', async ({ page, swHelper }) => {
    test.setTimeout(30_000);
    await swHelper.setServerTestParameters({
        saveResponses: true,
        intercept: {
            pattern: '**/telemetry-manifest.json',
            formula: 'empty',
            statusCode: 500,
        },
    });
    await page.goto('/telemetry.html');
    await page.waitForURL(/.*\/sw-api/);

    await waitForCaptures(swHelper, '/capture/events-config', (posts) =>
        posts.some((p) => p.events.some((e) => e.status === 'MANIFEST_UNTRUSTED'))
    );

    const manifestHits = await listCapturesAt(swHelper, '/capture/events');
    expect(manifestHits).toEqual([]);
});

/*
 * Observational: how long does the SW survive under persistent 500 failures?
 *
 * Chromium gives a SW ~30s idle before termination; waitUntil + fetch events
 * can extend that. These tests force /capture/events to 500 so every ship
 * fails, then measure wall time to SW close under two conditions:
 *   A. Tab stays on /telemetry.html with periodic fetches generating events.
 *   B. Tab navigates to about:blank — SW has waiting batches but no activity.
 *
 * Timings are logged, not asserted precisely; we only check SW eventually
 * closes so the test terminates.
 */
test.describe('500-survival (observational)', () => {
    test.setTimeout(5 * 60 * 1000);

    test.beforeEach(async ({ page, swHelper }) => {
        test.skip(
            !process.env.RUN_SURVIVAL_TESTS,
            'observational timing probe; opt in via RUN_SURVIVAL_TESTS=1'
        );
        await page.goto('/telemetry.html');
        await swHelper.waitForServiceWorkerActivation();
    });

    async function force500AndTamper(swHelper: SWHelper) {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: [
                { pattern: '**/dappfence.js', formula: 'default' },
                { pattern: '/capture/events', formula: 'unchanged', statusCode: 500 },
            ],
        });
    }

    async function pickActiveSw(swHelper: SWHelper): Promise<ServiceWorkerWithClose> {
        const sws = await swHelper.waitForServiceWorkers(1);
        return sws[sws.length - 1];
    }

    test('A: tab open with periodic activity — SW lifetime under failing sends', async ({
        page,
        swHelper,
    }) => {
        await force500AndTamper(swHelper);
        await page.reload();
        // PROTECTED mode redirects to warning page on the tampered subresource.
        await page.waitForURL(/.*\/sw-api/);

        const sw = await pickActiveSw(swHelper);
        const start = Date.now();

        // Keep the SW busy with periodic fetches from the page. Each triggers
        // reportAfterFetch → onEvent → cycle attempt → 500 → retry schedule.
        const activityHandle = page.evaluate(async () => {
            for (let i = 0; i < 60; i++) {
                try {
                    await fetch('/api/test-responses', { cache: 'no-store' });
                } catch {
                    // ignore
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
        });

        await sw.waitUntilClosed(3 * 60 * 1000).catch(() => {});
        const elapsedMs = Date.now() - start;
        console.log(`[survival A] SW alive ${(elapsedMs / 1000).toFixed(1)}s under activity`);
        expect(elapsedMs).toBeGreaterThan(0);
        await activityHandle.catch(() => {});
    });

    test('B: navigate to about:blank — SW lifetime with no page activity', async ({
        page,
        swHelper,
    }) => {
        await force500AndTamper(swHelper);
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);

        const sw = await pickActiveSw(swHelper);
        const start = Date.now();

        // Navigate away: no more fetches hit the SW. Waiting batches sit in
        // IDB; cycle exits idle; keepalive winds down after grace.
        await page.goto('about:blank');

        await sw.waitUntilClosed(3 * 60 * 1000).catch(() => {});
        const elapsedMs = Date.now() - start;
        console.log(`[survival B] SW alive ${(elapsedMs / 1000).toFixed(1)}s with no activity`);
        expect(elapsedMs).toBeGreaterThan(0);
    });
});

/*
 * Batching mechanics — observed via telemetryBatches IDB rows + envelope POSTs.
 *
 * Good case: a page load produces exactly one batch row and one POST carrying
 * every event.
 *
 * Failure case: with /capture/events returning 500, batches accumulate unsent
 * in IDB. Once the endpoint recovers, a single POST ships the union of every
 * previously-unsent batch's events and flips them all to sentAt.
 */

test.describe('batching mechanics', () => {
    test.beforeEach(async ({ swHelper }) => {
        await swHelper.setServerTestParameters({ saveResponses: true });
    });

    test('multiple events share a single POST (batching aggregates)', async ({
        page,
        swHelper,
    }) => {
        await page.goto('/telemetry.html');
        await swHelper.waitForServiceWorkerActivation();
        // Reload immediately: the install-time cycle is still collecting when
        // the reload's subresource verdicts arrive, so they end up in the
        // SAME cycle. One-page load → one POST, matching the batching intent.
        await page.reload();

        const posts = await waitForCaptures(swHelper, '/capture/events', (ps) => ps.length >= 1);
        expect(posts.length).toBe(1);
        const burst = posts[0];
        expect(burst.events.length).toBeGreaterThan(1);

        const batches = await readStore(
            page,
            'telemetryBatches',
            (bs) => bs.length >= 1 && bs.every((b) => b.sentAt != null)
        );
        expect(batches.every((b) => b.priority === false)).toBe(true);
        expect(new Set(batches.flatMap((b) => b.events).map((e) => e.key))).toEqual(
            new Set(burst.events.map((e) => e.key))
        );
    });

    test('unsent batches ship once the endpoint recovers', async ({ page, swHelper }) => {
        await swHelper.setServerTestParameters({
            intercept: { pattern: '/capture/events', formula: 'unchanged', statusCode: 500 },
        });
        await page.goto('/telemetry.html');
        await swHelper.waitForServiceWorkerActivation();
        await swHelper.sendHardReload();
        await page.waitForLoadState('networkidle');
        // Give the executor enough time to form a batch and attempt the (failing) POST.
        await page.waitForTimeout(5_000);

        const unsent = await readStore(
            page,
            'telemetryBatches',
            (bs) => bs.length >= 1 && bs.every((b) => b.sentAt == null),
            { timeout: 15_000 }
        );
        const unsentKeys = new Set(unsent.flatMap((b) => b.events.map((e) => e.key)));

        await swHelper.setServerTestParameters({ intercept: [] });
        await swHelper.sendHardReload();

        const posts = await waitForCaptures(swHelper, '/capture/events', (ps) =>
            ps.some((p) => {
                const keys = new Set(p.events.map((e) => e.key));
                return [...unsentKeys].every((k) => keys.has(k));
            })
        );
        const recoveredPost = posts.find((p) => {
            const keys = new Set(p.events.map((e) => e.key));
            return [...unsentKeys].every((k) => keys.has(k));
        });
        expect(recoveredPost).toBeDefined();

        await readStore(
            page,
            'telemetryBatches',
            (bs) => unsent.every((u) => bs.some((b) => b.id === u.id && b.sentAt != null)),
            { timeout: 15_000 }
        );
    });

    /*
     * Natural-heartbeat retry curve: the client's startReportEventsPing fires every
     * 15 s in dev, driving telemetryExecutor.onEvent — which bails during backoff
     * and ships otherwise. Several failed attempts should accumulate retry state
     * exponentially; once the endpoint recovers, the next heartbeat merges every
     * previously-unsent batch into one POST and resets retry state. Takes ~60-90 s.
     */
    const isRetryState = (v) =>
        !!v && typeof v === 'object' && 'attemptNumber' in v && 'nextAttemptAt' in v;

    test('exponential backoff accumulates and ships everything on recovery', async ({
        page,
        swHelper,
    }) => {
        test.skip(
            !process.env.RUN_RETRY_TESTS,
            'retry curve, driven by the 15 s heartbeat; opt in via RUN_RETRY_TESTS=1'
        );
        test.setTimeout(3 * 60 * 1000);

        await swHelper.setServerTestParameters({
            intercept: { pattern: '/capture/events', formula: 'unchanged', statusCode: 500 },
        });
        await page.goto('/telemetry.html');
        await swHelper.waitForServiceWorkerActivation();

        // Wait for the heartbeat to drive several failed attempts.
        await readStore(
            page,
            'settings',
            (rows) => {
                const state = rows.find(isRetryState);
                return !!state && state.attemptNumber >= 2;
            },
            { timeout: 60_000 }
        );

        const unsent = await readStore(
            page,
            'telemetryBatches',
            (bs) => bs.length >= 1 && bs.every((b) => b.sentAt == null)
        );
        const unsentKeys = new Set(unsent.flatMap((b) => b.events.map((e) => e.key)));
        expect(unsentKeys.size).toBeGreaterThan(0);

        // Recover the endpoint. Next heartbeat (within 15 s + current backoff)
        // triggers a cycle whose single POST ships every accumulated event.
        await swHelper.setServerTestParameters({ intercept: [] });

        // Wait for recovery: the retry state resetting to attemptNumber=0 is
        // the signal that a POST succeeded. Can't use waitForCaptures matching
        // on event keys here because FAILED POSTs also carry those keys (SW is
        // trying to ship them, server captures the body before responding 500).
        await readStore(
            page,
            'settings',
            (rows) => {
                const state = rows.find(isRetryState);
                return !!state && state.attemptNumber === 0;
            },
            { timeout: 90_000 }
        );

        await readStore(
            page,
            'telemetryBatches',
            (bs) => unsent.every((u) => bs.some((b) => b.id === u.id && b.sentAt != null)),
            { timeout: 15_000 }
        );

        const finalSettings = await readStore(page, 'settings');
        const finalState = finalSettings.find(isRetryState);
        expect(finalState).toBeDefined();
        expect(finalState.attemptNumber).toBe(0);
        expect(finalState.nextAttemptAt).toBe(0);

        // Backoff curve: validate server-side intervals between successive
        // failed POST attempts. The 15 s heartbeat is a floor; exponential
        // backoff pushes later intervals higher once base > heartbeat.
        const allPosts = await listCapturesAt(swHelper, '/capture/events');
        const failedPosts = allPosts.filter((p) => p.statusCode === 500);
        const recoveryPosts = allPosts.filter((p) => p.statusCode === 200);
        expect(failedPosts.length).toBeGreaterThanOrEqual(2);
        expect(recoveryPosts.length).toBe(1);

        const failedServerTimes = failedPosts.map((p) => p.receivedAt);
        const failedIntervals = failedServerTimes.slice(1).map((t, i) => t - failedServerTimes[i]);
        console.log(`[backoff] failed-attempt intervals (ms): ${failedIntervals.join(', ')}`);
        for (const dt of failedIntervals) {
            expect(dt).toBeGreaterThanOrEqual(10_000); // heartbeat is 15 s, allow some slack
        }
    });
});
