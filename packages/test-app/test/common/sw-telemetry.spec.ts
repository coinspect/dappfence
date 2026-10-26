/*
 * End-to-end telemetry reporting.
 *
 * telemetry.html uses telemetry-manifest.json (PROTECTED mode) which declares
 *   telemetry: { endpoint: '/capture/telemetry-from-manifest' }
 * The page also carries data-telemetry-endpoint="/capture/telemetry-from-config"
 * (via its templateFlags), so both the manifest URL and the config URL are set.
 * The SW must prefer the manifest URL
 * (`manifest.telemetry.endpoint ?? config.telemetryEndpoint`).
 *
 * In PROTECTED mode, a tampered subresource triggers a block + warning-page
 * redirect; the telemetry POST fires regardless, and IDB access via the page
 * (even once it is on the warning-page URL) still works because the origin is
 * unchanged.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../sw-fixtures';
import type { SWHelper } from '../sw-fixtures';

type CapturedPost = {
    result: string;
    requestPath: string;
    body: string;
};

type TelemetryEnvelope = {
    sessionId: string;
    appVersion: string | null;
    origin: string;
    userAgent: string;
    sentAt: string;
    events: Array<{
        id: string;
        fileKey: string;
        url?: string;
        status: string;
        reason?: string;
        actualHash?: string;
        expectedHashes?: string[];
    }>;
};

type BlockRecord = {
    id: string;
    fileKey: string;
    status: string;
    timestamp: string;
    lastSeen: string;
    occurrenceCount: number;
    reportedAt: string | null;
};

async function readTelemetryPosts(
    swHelper: { getServerResponses: () => Promise<unknown[]> },
    endpointPath: string
): Promise<TelemetryEnvelope[]> {
    const entries = (await swHelper.getServerResponses()) as CapturedPost[];
    return entries
        .filter((e) => e.result === 'capture' && e.requestPath === endpointPath)
        .map((e) => JSON.parse(e.body) as TelemetryEnvelope);
}

async function readBlocks(page: Page, swHelper: SWHelper): Promise<Record<string, BlockRecord>> {
    const raw = (await swHelper.storageGet(page, 'blocks')) as unknown;
    return (raw ?? {}) as Record<string, BlockRecord>;
}

const TAMPER_DAPPFENCE_JS = {
    pattern: '**/dappfence.js',
    formula: 'inject' as const,
    args: ';window.__tampered = true;',
};

const TAMPER_MANIFEST = {
    pattern: '**/telemetry-manifest.json',
    formula: 'default' as const,
};

const FORCE_500 = (pathSuffix: string) => ({
    pattern: pathSuffix,
    formula: 'unchanged' as const,
    statusCode: 500,
});

test.describe('telemetry reporting', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('/telemetry.html');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('subresource violation triggers POST to the manifest-sourced endpoint', async ({
        page,
        swHelper,
        baseURL,
    }) => {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: TAMPER_DAPPFENCE_JS,
        });
        await page.reload();

        let posts: TelemetryEnvelope[] = [];
        await expect
            .poll(async () => {
                posts = await readTelemetryPosts(swHelper, '/capture/telemetry-from-manifest');
                return posts.length;
            })
            .toBeGreaterThan(0);

        const expectedOrigin = new URL(baseURL!).origin;
        const envelope = posts[0];
        expect(envelope.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
        expect(envelope.origin).toBe(expectedOrigin);
        expect(envelope.appVersion).toBeTruthy();
        expect(envelope.userAgent).toBeTruthy();
        expect(envelope.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Only /dappfence.js is tampered, so exactly one block exists in IDB.
        // Each envelope therefore carries exactly one event. (Concurrent drains
        // could POST the same block more than once — no in-flight lock on
        // sendPendingReports — but every envelope still has length 1.)
        expect(envelope.events).toHaveLength(1);
        const [event] = envelope.events;
        expect(event).toMatchObject({
            fileKey: '/dappfence.js',
            url: `${expectedOrigin}/dappfence.js`,
            status: 'FILE_UNTRUSTED',
            reason: 'HASH_MISMATCH',
        });
        expect(event.actualHash).toMatch(/^sha256-/);
        expect(event.expectedHashes).toBeInstanceOf(Array);
        expect(event.expectedHashes!.length).toBeGreaterThan(0);
        expect(event.expectedHashes![0]).toMatch(/^sha256-/);
    });

    test('manifest URL wins — no POST to the config-fallback endpoint', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: TAMPER_DAPPFENCE_JS,
        });
        await page.reload();

        let manifestPosts: TelemetryEnvelope[] = [];
        await expect
            .poll(async () => {
                manifestPosts = await readTelemetryPosts(
                    swHelper,
                    '/capture/telemetry-from-manifest'
                );
                return manifestPosts.length;
            })
            .toBeGreaterThan(0);

        const totalEvents = manifestPosts.reduce((n, p) => n + p.events.length, 0);
        expect(totalEvents).toBeGreaterThan(0);
        expect(manifestPosts.some((p) => p.events.some((e) => e.fileKey === '/dappfence.js'))).toBe(
            true
        );

        const configHits = await readTelemetryPosts(swHelper, '/capture/telemetry-from-config');
        expect(configHits).toEqual([]);
    });

    test('manifest tamper is reported as MANIFEST_UNTRUSTED using the cached manifest URL', async ({
        page,
        swHelper,
    }) => {
        // Tamper both a subresource (so the verifier escalates) and the manifest
        // (so the escalation's re-fetch fails signature verification). The
        // cached manifest supplies the telemetry URL; the re-fetched tampered
        // manifest triggers the MANIFEST_UNTRUSTED verdict that gets reported.
        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: [TAMPER_DAPPFENCE_JS, TAMPER_MANIFEST],
        });
        await page.reload();

        const posts: TelemetryEnvelope[] = [];
        await expect
            .poll(
                async () => {
                    posts.length = 0;
                    for (const p of await readTelemetryPosts(
                        swHelper,
                        '/capture/telemetry-from-manifest'
                    )) {
                        posts.push(p);
                    }
                    return posts.some((p) =>
                        p.events.some((e) => e.status === 'MANIFEST_UNTRUSTED')
                    );
                },
                { timeout: 10_000 }
            )
            .toBe(true);

        const manifestEvent = posts
            .flatMap((p) => p.events)
            .find((e) => e.status === 'MANIFEST_UNTRUSTED');
        expect(manifestEvent).toBeDefined();
        expect(manifestEvent!.fileKey).toBe('/telemetry-manifest.json');
        expect(manifestEvent!.reason).toBeTruthy();
    });

    // Playwright doesn't enable background sync for some reason
    test.fixme(
        '500 then success: Background Sync retry marks the block reported',
        async ({ page, swHelper, baseURL, context }) => {
            const origin = new URL(baseURL!).origin;
            await context.grantPermissions(['background-sync'], { origin });
            await swHelper.setServerTestParameters({
                saveResponses: true,
                intercept: [TAMPER_DAPPFENCE_JS, FORCE_500('/capture/telemetry-from-manifest')],
            });

            // Register the sync log waiter BEFORE triggering the condition; the
            // SW logs `reportOnSync lastChance=...` when the sync handler fires.
            const syncLog = swHelper.waitForServiceWorkerMessage('reportOnSync');
            swHelper.consoleLogDebug();
            await page.reload();

            await expect
                .poll(async () => {
                    return (await readTelemetryPosts(swHelper, '/capture/telemetry-from-manifest'))
                        .length;
                })
                .toBeGreaterThan(0);

            const blocksAfterFailure = await readBlocks(page, swHelper);
            const failed = Object.values(blocksAfterFailure).find(
                (b) => b.fileKey === '/dappfence.js'
            );
            expect(failed, 'block for /dappfence.js must exist in IDB').toBeDefined();
            expect(failed!.reportedAt, 'reportedAt must stay null after 500').toBeNull();

            const failedPostCount = (
                await readTelemetryPosts(swHelper, '/capture/telemetry-from-manifest')
            ).length;

            // Clear intercepts so the sync-driven retry POST reaches a 2xx endpoint.
            await swHelper.setServerTestParameters({ saveResponses: true, intercept: [] });

            // sync fires within ~1 s once the browser is online + a sync tag is
            // registered. Give it 10 s to allow for Chromium backoff timing.
            const { msg } = (await syncLog) as { msg: { text: () => string } };
            expect(msg.text()).toContain('reportOnSync');

            await expect
                .poll(
                    async () => {
                        return (
                            await readTelemetryPosts(swHelper, '/capture/telemetry-from-manifest')
                        ).length;
                    },
                    { timeout: 10_000, intervals: [250, 500, 1_000] }
                )
                .toBeGreaterThan(failedPostCount);

            const blocksAfterSuccess = await readBlocks(page, swHelper);
            const succeeded = Object.values(blocksAfterSuccess).find(
                (b) => b.fileKey === '/dappfence.js'
            );
            expect(succeeded!.reportedAt, 'reportedAt must be set after sync retry').not.toBeNull();
        }
    );

    test('client ping (startReportEventsPing) also drives a drain', async ({ page, swHelper }) => {
        // Register the client-ping log waiter BEFORE triggering the condition.
        // The SW logs `reportOnClientRequest clientId=...` when the ping fires.
        // In dev mode the ping interval is 15 s; give it 20 s to allow for
        // scheduling delay and jitter.
        const pingLog = swHelper.waitForServiceWorkerMessage('reportOnClientRequest');

        await swHelper.setServerTestParameters({
            saveResponses: true,
            intercept: TAMPER_DAPPFENCE_JS,
        });
        await page.reload();

        // Wait for the client-request log line explicitly. Sync may also fire
        // first and drain the block — that's fine; we're asserting the ping
        // path itself works, not that it's the sole drainer.
        const { msg } = (await Promise.race([
            pingLog,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('reportOnClientRequest timed out')), 20_000)
            ),
        ])) as { msg: { text: () => string } };
        expect(msg.text()).toContain('reportOnClientRequest');
    });
});
