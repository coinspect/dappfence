import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelemetryExecutor } from '../telemetry/telemetry-executor.js';
import { createSecurityProcessor } from '../security-processor.js';
import { createSecurityStore } from '../storage/security-store.js';
import { createSettingsStore } from '../storage/settings-store.js';
import { createTelemetryBatchesStore } from '../storage/telemetry-batches-store.js';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { SYNC_TAG_REPORT_EVENTS, VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

// Executor cycles use real timers (TICK_MS = 500), so each cycle takes ~1s.
const CYCLE_TIMEOUT_MS = 10_000;
const EVENTS_ENDPOINT = 'https://telemetry.test/events';

const okResponse = () => ({ ok: true, status: 200 });

function createHarness({ fetch, registerSync = vi.fn(async () => {}) }) {
    const db = createInMemoryDb();
    const appStore = {
        securityStore: createSecurityStore(db),
        settingsStore: createSettingsStore(db),
        verificationResultsStore: createVerificationResultsStore(db),
        telemetryBatchesStore: createTelemetryBatchesStore(db),
    };
    const swContext = {
        fetch: vi.fn(fetch),
        registerSync,
        getLocationOrigin: () => 'https://app.test',
        getUserAgent: () => 'vitest',
    };
    const manifestService = {
        resolveManifest: async () => ({
            appVersion: 'v1',
            telemetryEndpoints: { events: EVENTS_ENDPOINT, logs: null },
        }),
    };
    const taskManager = { attach: () => {}, run: async (fn) => fn() };
    const telemetryExecutor = createTelemetryExecutor({
        swContext,
        appStore,
        manifestService,
        taskManager,
    });
    const securityProcessor = createSecurityProcessor({
        appStore,
        telemetryExecutor,
        taskManager,
    });
    return { appStore, swContext, telemetryExecutor, securityProcessor };
}

const violation = (extras = {}) => ({
    status: VERIFICATION_STATUS.FILE_UNTRUSTED,
    fileKey: '/app.js',
    manifestInfo: { appVersion: 'v1' },
    ...extras,
});

describe('telemetry executor: Background Sync retry', () => {
    beforeEach(() => {
        // Deterministic backoff: first retry lands exactly BACKOFF_BASE_MS out.
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it(
        'a sync event after a failed POST either delivers the batch or rejects for a retry',
        async () => {
            let calls = 0;
            const { appStore, swContext, telemetryExecutor, securityProcessor } = createHarness({
                fetch: async () => {
                    calls += 1;
                    if (calls === 1) {
                        throw new TypeError('Failed to fetch');
                    }
                    return okResponse();
                },
            });
            await appStore.verificationResultsStore.add(violation());

            expect(await telemetryExecutor.onEvent()).toBe(false);
            expect(swContext.registerSync).toHaveBeenCalledWith(SYNC_TAG_REPORT_EVENTS);

            // Chromium fires the registered sync as soon as it sees connectivity,
            // typically well inside the first backoff window.
            const outcome = await securityProcessor
                .reportOnSync({ tag: SYNC_TAG_REPORT_EVENTS, lastChance: false })
                .then(
                    () => 'resolved',
                    () => 'rejected'
                );
            const unsent = (await appStore.telemetryBatchesStore.getPending()).length;

            // Resolving tells the browser the sync succeeded and drops the
            // registration — only valid once nothing is left to send.
            expect(
                outcome === 'rejected' || unsent === 0,
                `sync ${outcome} with ${unsent} unsent batch(es) and ${calls} POST(s)`
            ).toBe(true);
        },
        CYCLE_TIMEOUT_MS
    );
});
