import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTelemetryExecutor } from '../telemetry/telemetry-executor.js';
import { createSecurityStore } from '../storage/security-store.js';
import { createSettingsStore } from '../storage/settings-store.js';
import { createTelemetryBatchesStore } from '../storage/telemetry-batches-store.js';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

// Executor cycles use real timers (TICK_MS = 500), so each cycle takes ~1s.
const CYCLE_TIMEOUT_MS = 10_000;
const EVENTS_ENDPOINT = 'https://telemetry.test/events';
// Fetch spec: in-flight keepalive request bodies are capped at 64 KiB.
const KEEPALIVE_QUOTA_BYTES = 64 * 1024;

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
    return { appStore, swContext, telemetryExecutor };
}

const violation = (extras = {}) => ({
    status: VERIFICATION_STATUS.FILE_UNTRUSTED,
    fileKey: '/app.js',
    manifestInfo: { appVersion: 'v1' },
    ...extras,
});

// Drive a full send cycle and report its delivery outcome.
async function drive(telemetryExecutor) {
    const stillPending = await telemetryExecutor.scheduleSyncSend();
    return !stillPending;
}

describe('telemetry executor: keepalive body quota', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it(
        'delivers a full 50-event batch whose JSON body exceeds 64 KiB',
        async () => {
            const posted = [];
            const { appStore, telemetryExecutor } = createHarness({
                // Emulate the browser: keepalive requests over the quota reject
                // with a TypeError before hitting the network.
                fetch: async (_url, init) => {
                    const size = new TextEncoder().encode(init.body).length;
                    if (init.keepalive && size > KEEPALIVE_QUOTA_BYTES) {
                        throw new TypeError(
                            `keepalive body ${size}B exceeds ${KEEPALIVE_QUOTA_BYTES}B quota`
                        );
                    }
                    posted.push(JSON.parse(init.body));
                    return okResponse();
                },
            });

            // 50 unique violations (the MAX_UNIQUE_EVENTS cap), each carrying a
            // realistic long URL and a few expected hashes: ~1.5 KiB per event.
            const hashes = Array.from({ length: 8 }, (_, i) => `sha256-${'A'.repeat(43)}${i}`);
            for (let i = 0; i < 50; i++) {
                await appStore.verificationResultsStore.add(
                    violation({
                        fileKey: `/assets/chunk-${i}.js`,
                        url: `https://app.test/assets/chunk-${i}.js?v=${'x'.repeat(800)}`,
                        expectedHashes: hashes,
                        actualHash: `sha256-${'B'.repeat(43)}${i}`,
                    })
                );
            }

            const delivered = await drive(telemetryExecutor);

            expect(delivered).toBe(true);
            expect(posted.flatMap((envelope) => envelope.events)).toHaveLength(50);
            expect(await appStore.telemetryBatchesStore.getPending()).toHaveLength(0);
        },
        CYCLE_TIMEOUT_MS
    );
});
