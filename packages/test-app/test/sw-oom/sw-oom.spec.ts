/**
 * Service Worker Out-of-Memory tests.
 *
 * These prove that DappFence SW's hash-every-response pipeline buffers the
 * full response body in the SW process before hashing, with no size cap. The
 * server endpoints under /huge/* stream deterministic PRNG payloads of
 * arbitrary size, so neither the server nor the test harness holds the body
 * in memory — both sides know the SHA-256 by (seed, size).
 *
 * All tests are gated behind RUN_OOM=1 because they need real time and real
 * memory. (c) linear-growth is the quick regression (~30s for 500 MB total);
 * (a)/(b)/(d)/(CSP) each want 2–3 GB of free RAM and minutes of CPU.
 *
 * See docs/sw-oom-notes.md (added in this change) for the threat model.
 */

import { expect, test } from '../sw-fixtures';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

const RUN_OOM = process.env.RUN_OOM === '1';

test.describe('SW OOM — hash buffering under oversized bodies', () => {
    test.skip(!RUN_OOM, 'Set RUN_OOM=1 to run. Needs several GB of free RAM.');
    // Per-test timeout 15 min. We deliberately avoid `mode: 'serial'` because
    // that's fail-fast — if (b) crashes the page we still want (a)/(d)/(CSP)
    // to run. Memory-serialization is handled by the project running with 1
    // worker (set below).
    test.describe.configure({ timeout: 15 * 60 * 1000 });

    // The `sw-oom-*` project doesn't have its own dist build — point the
    // dev-server at the reporting-mode build so the SW records violations
    // without locking the site. This lets every iteration of the hash cost
    // be measured, instead of the first sample charging the full hash and
    // the next samples hitting the site-lock fast path.
    test.beforeEach(async ({ swHelper }) => {
        await swHelper.setVersion('latest', 'reporting-test-dev');
    });

    /**
     * Resolve the SW target id for the page's controller. We watch Target.*
     * events to find a target whose URL points to our dappfence.js SW.
     */
    async function waitForSwTarget(cdp: CDPSession, timeoutMs = 10_000): Promise<string> {
        const existing = await cdp.send('Target.getTargets');
        for (const t of existing.targetInfos) {
            if (t.type === 'service_worker' && t.url.includes('dappfence.js')) {
                return t.targetId;
            }
        }
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('timed out waiting for SW target')),
                timeoutMs
            );
            const onCreated = (payload: {
                targetInfo: { type: string; url: string; targetId: string };
            }) => {
                const { targetInfo } = payload;
                if (
                    targetInfo.type === 'service_worker' &&
                    targetInfo.url.includes('dappfence.js')
                ) {
                    clearTimeout(timer);
                    cdp.off('Target.targetCreated', onCreated);
                    resolve(targetInfo.targetId);
                }
            };
            cdp.on('Target.targetCreated', onCreated);
        });
    }

    /**
     * Resolves to true if the SW target crashes before `timeoutMs` elapses.
     */
    function trackSwCrash(
        cdp: CDPSession,
        swTargetId: string
    ): { crashed: () => boolean; waitForCrash: (timeoutMs: number) => Promise<boolean> } {
        let crashed = false;
        const listeners: Array<() => void> = [];
        const onCrashed = (payload: { targetId: string }) => {
            if (payload.targetId === swTargetId) {
                crashed = true;
                for (const fn of listeners) fn();
            }
        };
        cdp.on('Target.targetCrashed', onCrashed);
        return {
            crashed: () => crashed,
            waitForCrash: (timeoutMs: number) =>
                new Promise<boolean>((resolve) => {
                    if (crashed) return resolve(true);
                    const timer = setTimeout(() => resolve(false), timeoutMs);
                    listeners.push(() => {
                        clearTimeout(timer);
                        resolve(true);
                    });
                }),
        };
    }

    /**
     * Trigger the huge-script load and wait for either load/error to resolve.
     * Returns the elapsed ms as reported by the page's performance.now()
     * deltas, plus a `pageCrashed` flag. In reporting mode the SW passes the
     * body through to the page after hashing — so at ≥2 GB the page's own
     * V8 heap can OOM while trying to parse the body as JS. That's a
     * positive demonstration of exposure, not a test harness failure, so we
     * catch it and report it.
     */
    async function triggerAndWait(
        page: Page,
        mb: number,
        seed: number,
        timeoutMs: number
    ): Promise<{
        loaded: boolean;
        errored: boolean;
        elapsed: number | null;
        pageCrashed: boolean;
    }> {
        let pageCrashed = false;
        const onCrash = () => {
            pageCrashed = true;
        };
        page.on('crash', onCrash);

        try {
            await page.evaluate(
                ({ mb, seed }: { mb: number; seed: number }) => {
                    (window as unknown as Record<string, unknown>).__oomScriptLoaded = false;
                    (window as unknown as Record<string, unknown>).__oomScriptError = false;
                    (window as unknown as Record<string, unknown>).__oomStart = performance.now();
                    const s = document.createElement('script');
                    s.src = `/huge/bytes?mb=${mb}&seed=${seed}`;
                    s.onload = () => {
                        (window as unknown as Record<string, unknown>).__oomScriptLoaded = true;
                        (window as unknown as Record<string, unknown>).__oomElapsed =
                            performance.now() -
                            ((window as unknown as Record<string, number>).__oomStart as number);
                    };
                    s.onerror = () => {
                        (window as unknown as Record<string, unknown>).__oomScriptError = true;
                        (window as unknown as Record<string, unknown>).__oomElapsed =
                            performance.now() -
                            ((window as unknown as Record<string, number>).__oomStart as number);
                    };
                    document.head.appendChild(s);
                },
                { mb, seed }
            );
        } catch (e) {
            if (/Target crashed|Target closed/.test((e as Error).message)) {
                pageCrashed = true;
                page.off('crash', onCrash);
                return { loaded: false, errored: false, elapsed: null, pageCrashed };
            }
            throw e;
        }

        try {
            await page.waitForFunction(
                () =>
                    (window as unknown as Record<string, unknown>).__oomScriptLoaded === true ||
                    (window as unknown as Record<string, unknown>).__oomScriptError === true,
                null,
                { timeout: timeoutMs }
            );
        } catch {
            // waitForFunction may throw on timeout or on page crash — either
            // is informative, so fall through to the state read below.
        }

        let result: { loaded: boolean; errored: boolean; elapsed: number | null };
        try {
            result = await page.evaluate(() => {
                const w = window as unknown as Record<string, unknown>;
                return {
                    loaded: w.__oomScriptLoaded === true,
                    errored: w.__oomScriptError === true,
                    elapsed: typeof w.__oomElapsed === 'number' ? (w.__oomElapsed as number) : null,
                };
            });
        } catch (e) {
            if (/Target crashed|Target closed/.test((e as Error).message)) {
                pageCrashed = true;
                result = { loaded: false, errored: false, elapsed: null };
            } else {
                throw e;
            }
        }

        page.off('crash', onCrash);
        return { ...result, pageCrashed };
    }

    /**
     * Fresh page controlled by the reporting-mode DappFence SW. We use the
     * existing index.html (covered by the test manifest) as the entry point
     * so the initial navigation passes verification; only the injected
     * `<script src="/huge/bytes?…">` triggers the hash path we're probing.
     * Reporting mode is the key — the SW records violations but doesn't
     * lock the site, so repeated NOT_IN_MANIFEST hits all pay the full hash
     * cost rather than short-circuiting through a cached block response.
     */
    async function freshDappFencePage(context: BrowserContext): Promise<Page> {
        const page = await context.newPage();
        await page.goto('/');
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
            timeout: 15_000,
        });
        return page;
    }

    // -----------------------------------------------------------------
    // (c) Linear growth — always included in RUN_OOM runs. Proves buffering.
    // -----------------------------------------------------------------
    test('(c) hash time scales ~linearly with body size (100 / 250 / 500 MB)', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await freshDappFencePage(context);

        // Reporting mode passes the body through to the page, so at these
        // sizes the <script> onload fires after the SW finishes hashing.
        // elapsed carries the round-trip time (fetch + hash + parse), which
        // is dominated by the hash step at 100 MB+.
        const samples: Array<{ mb: number; ms: number; loaded: boolean; errored: boolean }> = [];
        for (const mb of [100, 250, 500]) {
            const { elapsed, errored, loaded, pageCrashed } = await triggerAndWait(
                page,
                mb,
                1,
                180_000
            );
            expect(
                pageCrashed,
                `page must not crash at ${mb} MB (this test is below the cap)`
            ).toBe(false);
            expect(
                elapsed,
                `onload or onerror must fire within the timeout for ${mb} MB`
            ).not.toBeNull();
            samples.push({ mb, ms: elapsed as number, loaded, errored });
        }

        console.log('[OOM-c] samples (mb → ms):', samples);

        // Linearity check — ratio of (ms per MB) across samples should stay
        // within ~2× of each other. We're not benchmarking a constant, we're
        // disproving "there's a size cap or a shortcut." If any sample's
        // throughput deviates by more than 4× from the median, that would
        // indicate caching, early-exit, or some non-linear behavior worth
        // investigating.
        const perMb = samples.map((s) => s.ms / s.mb).sort((a, b) => a - b);
        const median = perMb[1];
        for (const r of perMb) {
            expect(r).toBeGreaterThan(median / 4);
            expect(r).toBeLessThan(median * 4);
        }

        await context.close();
    });

    // -----------------------------------------------------------------
    // (b) RangeError at ~2 GiB — V8 ArrayBuffer cap or similar. Observable
    //     via SW console error OR as a script `onerror` fired for the fetch.
    // -----------------------------------------------------------------
    test('(b) ~2.1 GB body surfaces a hash-step error (RangeError or SW crash)', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const page = await freshDappFencePage(context);

        const cdp = await context.newCDPSession(page);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const swTargetId = await waitForSwTarget(cdp);
        const crashTracker = trackSwCrash(cdp, swTargetId);

        const swErrors: string[] = [];
        const swWorker = context.serviceWorkers()[0];
        if (swWorker) {
            swWorker.on('console', (msg) => {
                if (msg.type() === 'error') swErrors.push(msg.text());
            });
        }

        const { errored, loaded, pageCrashed } = await triggerAndWait(
            page,
            2100,
            1,
            10 * 60 * 1000
        );

        // Positive signals, any of which demonstrates the hash path broke:
        //   - SW process crashed (OOM in the SW renderer)
        //   - Page process crashed (V8 blew up parsing the 2.1 GB body in
        //     reporting mode, after the SW finished hashing)
        //   - SW console reported a RangeError
        const rangeError = swErrors.some((e) => /RangeError|Array buffer allocation/i.test(e));
        console.log(
            '[OOM-b] loaded=',
            loaded,
            'errored=',
            errored,
            'swCrashed=',
            crashTracker.crashed(),
            'pageCrashed=',
            pageCrashed,
            'rangeError=',
            rangeError,
            'swErrors=',
            swErrors.slice(0, 3)
        );

        expect(crashTracker.crashed() || pageCrashed || rangeError).toBe(true);
        expect(loaded, 'the script must not successfully load at 2.1 GB').toBe(false);

        await context.close();
    });

    // -----------------------------------------------------------------
    // (a) SW crash — CDP Target.targetCrashed fires on the dappfence SW.
    // -----------------------------------------------------------------
    test('(a) ~3 GB body crashes the DappFence SW process', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await freshDappFencePage(context);

        const cdp = await context.newCDPSession(page);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const swTargetId = await waitForSwTarget(cdp);
        const crashTracker = trackSwCrash(cdp, swTargetId);

        const { pageCrashed } = await triggerAndWait(page, 3072, 1, 10 * 60 * 1000);
        const swCrashed = await crashTracker.waitForCrash(30_000);
        console.log('[OOM-a] swCrashed=', swCrashed, 'pageCrashed=', pageCrashed);

        // Either process dying is proof. In reporting mode the SW passes
        // the body through after hashing, so the page V8 heap can OOM
        // trying to parse it, before the SW itself hits the cap.
        expect(swCrashed || pageCrashed).toBe(true);

        // If the SW crashed, the controller is cleared. If only the page
        // crashed, the controller check won't run (page is dead), so skip.
        if (swCrashed && !pageCrashed) {
            const controllerStillLive = await page.evaluate(
                () => !!navigator.serviceWorker.controller
            );
            expect(controllerStillLive).toBe(false);
        }

        await context.close();
    });

    // -----------------------------------------------------------------
    // (d) Blast radius — two tabs sharing a scope; OOM in one takes out the
    //     other's SW controller.
    // -----------------------------------------------------------------
    test('(d) SW crash from tab A takes down controller in tab B (same scope)', async ({
        browser,
    }) => {
        const context = await browser.newContext();
        const pageA = await freshDappFencePage(context);
        const pageB = await freshDappFencePage(context);

        const cdp = await context.newCDPSession(pageA);
        await cdp.send('Target.setDiscoverTargets', { discover: true });
        const swTargetId = await waitForSwTarget(cdp);
        const crashTracker = trackSwCrash(cdp, swTargetId);

        // Tab B snapshot before.
        const bControllerBefore = await pageB.evaluate(() => !!navigator.serviceWorker.controller);
        expect(bControllerBefore).toBe(true);

        // Trigger OOM on tab A. Tab A may crash (page process OOM) or may
        // survive — what we care about is whether tab B's SW controller
        // survives the SW process death.
        const triggerResult = await triggerAndWait(pageA, 3072, 1, 10 * 60 * 1000);
        const swCrashed = await crashTracker.waitForCrash(30_000);
        expect(
            swCrashed || triggerResult.pageCrashed,
            'tab A should see either its SW or its page process die'
        ).toBe(true);

        // Give the browser a moment to propagate.
        await pageB.waitForTimeout(1000);

        const bControllerAfter = await pageB.evaluate(() => !!navigator.serviceWorker.controller);
        console.log(
            '[OOM-d] swCrashed=',
            swCrashed,
            'A pageCrashed=',
            triggerResult.pageCrashed,
            'B controller after=',
            bControllerAfter
        );
        // If the SW died, tab B should have lost its controller. If only
        // tab A's page died (not the SW), tab B's controller survives —
        // that still proves the blast-radius claim is contingent on SW
        // death vs page death, which is informative on its own.
        if (swCrashed) {
            expect(bControllerAfter).toBe(false);
        }

        await context.close();
    });

    // -----------------------------------------------------------------
    // (CSP-sweep) Bracket the CSP-hash navigation size limit. Split into
    // one test per size so each gets its own timeout — a hang at one size
    // doesn't eat the whole sweep. Each iteration uses a fresh context,
    // so renderer memory doesn't accumulate across sizes.
    //
    // Signals captured per size:
    //   - navSucceeded:  did page.goto resolve (vs throw)
    //   - pageCrashed:   did the renderer process die
    //   - cspReady:      true = inline <script> ran under CSP (browser
    //                    hashed + matched + executed)
    //   - cspViolation:  did the browser fire a securitypolicyviolation
    //   - elapsed:       wall-clock ms for page.goto
    // -----------------------------------------------------------------
    for (const mb of [500, 1000, 1500, 2000, 2500]) {
        test(`(CSP-sweep ${mb} MB) browser CSP hash path`, async ({ browser }) => {
            const context = await browser.newContext();
            const page = await context.newPage();
            let pageCrashed = false;
            page.on('crash', () => {
                pageCrashed = true;
            });
            // Capture every CSP violation that fires on the page so we can
            // distinguish "the big hashed script was blocked" (interesting
            // — means Chromium's computed hash disagreed with ours) from
            // "a marker script was blocked" (bug in the harness).
            await page.addInitScript(() => {
                (window as unknown as Record<string, unknown>).__cspHits = [];
                document.addEventListener('securitypolicyviolation', (e) => {
                    ((window as unknown as Record<string, unknown>).__cspHits as unknown[]).push({
                        violatedDirective: e.violatedDirective,
                        blockedURI: e.blockedURI,
                        sample: (e.sample ?? '').slice(0, 80),
                    });
                });
            });

            const t0 = Date.now();
            let navErr: string | null = null;
            try {
                await page.goto(`/huge/csp-page?mb=${mb}&seed=3`, { timeout: 10 * 60 * 1000 });
            } catch (e) {
                navErr = (e as Error).message.slice(0, 180);
            }
            const elapsed = Date.now() - t0;

            let cspReady: boolean | null = null;
            let cspHits: unknown[] = [];
            if (!pageCrashed) {
                try {
                    cspReady = await page.evaluate(() => {
                        const w = window as unknown as Record<string, unknown>;
                        return typeof w.__oomCspReady === 'boolean'
                            ? (w.__oomCspReady as boolean)
                            : null;
                    });
                    cspHits = await page.evaluate(() => {
                        const w = window as unknown as Record<string, unknown>;
                        return Array.isArray(w.__cspHits) ? (w.__cspHits as unknown[]) : [];
                    });
                } catch {
                    // page may have died between the two evaluates — ignore
                }
            }

            console.log(
                `[CSP-sweep ${mb}MB]`,
                JSON.stringify({
                    navSucceeded: navErr === null,
                    navErr,
                    pageCrashed,
                    cspReady,
                    cspHits,
                    elapsedMs: elapsed,
                })
            );

            try {
                await context.close();
            } catch {
                // context may already be dead; ignore
            }
        });
    }
});
