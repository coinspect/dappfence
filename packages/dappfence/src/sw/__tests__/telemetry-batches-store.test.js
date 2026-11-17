import { describe, it, expect, beforeEach } from 'vitest';
import { createTelemetryBatchesStore } from '../storage/telemetry-batches-store.js';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';
import { withTransactionLifetime } from './helpers/transaction-lifetime.js';

const batch = (overrides = {}) => ({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    priority: false,
    ...overrides,
});

describe('createTelemetryBatchesStore', () => {
    let store;

    beforeEach(() => {
        store = createTelemetryBatchesStore(createInMemoryDb());
    });

    it('add + get round-trips a batch', async () => {
        const b = batch({ priority: true });
        await store.add(b);
        expect(await store.get(b.id)).toMatchObject({
            id: b.id,
            priority: true,
        });
    });

    it('get returns undefined for unknown id', async () => {
        expect(await store.get('nope')).toBeUndefined();
    });

    it('getAll returns every batch', async () => {
        await store.add(batch());
        await store.add(batch());
        await store.add(batch({ sentAt: 1000 }));
        expect(await store.getAll()).toHaveLength(3);
    });

    it('withRetryTxForStream stamps sentAt on multiple batches in one tx', async () => {
        const b1 = batch();
        const b2 = batch();
        await store.add(b1);
        await store.add(b2);
        await store.withRetryTxForStream('events', async ({ telemetryBatches }) => {
            const now = Date.now();
            for (const id of [b1.id, b2.id]) {
                const found = await telemetryBatches.get(id);
                found.sentAt = now;
                await telemetryBatches.put(found);
            }
        });
        const after1 = await store.get(b1.id);
        const after2 = await store.get(b2.id);
        expect(typeof after1.sentAt).toBe('number');
        expect(after1.sentAt).toBe(after2.sentAt);
    });

    it('withRetryTxForStream with an empty body is a no-op', async () => {
        await expect(store.withRetryTxForStream('events', async () => {})).resolves.toBeUndefined();
    });

    it('withRetryTxForStream caller can skip unknown ids and still stamp known ones', async () => {
        const b = batch();
        await store.add(b);
        await store.withRetryTxForStream('events', async ({ telemetryBatches }) => {
            for (const id of ['ghost', b.id]) {
                const found = await telemetryBatches.get(id);
                if (!found) {
                    continue;
                }
                found.sentAt = Date.now();
                await telemetryBatches.put(found);
            }
        });
        const after = await store.get(b.id);
        expect(typeof after.sentAt).toBe('number');
    });

    it('getRetryStateForStream returns undefined when unset; caller supplies default', async () => {
        expect(await store.getRetryStateForStream('events')).toBeUndefined();
    });

    it('retry.get returns undefined when unset; caller supplies default', async () => {
        await store.withRetryTxForStream('events', async ({ retry }) => {
            expect(await retry.get()).toBeUndefined();
        });
    });

    it('retry.put persists; subsequent getRetryStateForStream returns the value', async () => {
        const v = { attemptNumber: 3, nextAttemptAt: 123456 };
        await store.withRetryTxForStream('events', async ({ retry }) => {
            await retry.put(v);
        });
        expect(await store.getRetryStateForStream('events')).toEqual(v);
    });

    it('retry state is isolated per stream', async () => {
        const vEvents = { attemptNumber: 2, nextAttemptAt: 1000 };
        const vLogs = { attemptNumber: 5, nextAttemptAt: 9999 };
        await store.withRetryTxForStream('events', async ({ retry }) => {
            await retry.put(vEvents);
        });
        await store.withRetryTxForStream('logs', async ({ retry }) => {
            await retry.put(vLogs);
        });
        expect(await store.getRetryStateForStream('events')).toEqual(vEvents);
        expect(await store.getRetryStateForStream('logs')).toEqual(vLogs);
    });

    it('count reflects total batches', async () => {
        expect(await store.count()).toBe(0);
        await store.add(batch());
        await store.add(batch());
        expect(await store.count()).toBe(2);
    });
});

describe('createTelemetryBatchesStore under real IDB transaction lifetime', () => {
    let db;
    let store;
    let verificationResultsStore;

    beforeEach(() => {
        db = withTransactionLifetime(createInMemoryDb());
        store = createTelemetryBatchesStore(db);
        verificationResultsStore = createVerificationResultsStore(db);
    });

    it('helper sanity: IDB-only transactions still commit via withRetryTxForStream', async () => {
        const b = batch();
        await store.add(b);
        await store.withRetryTxForStream('events', async ({ telemetryBatches }) => {
            const found = await telemetryBatches.get(b.id);
            found.sentAt = Date.now();
            await telemetryBatches.put(found);
        });
        expect(typeof (await store.get(b.id)).sentAt).toBe('number');
    });

    it('createBatch runs selectVerdicts and writes the batch atomically', async () => {
        await verificationResultsStore.add({
            status: VERIFICATION_STATUS.FILE_UNTRUSTED,
            fileKey: '/app.js',
            manifestInfo: { appVersion: 'v1' },
        });

        const batch = await store.createBatch((verdicts) => verdicts);

        expect(batch).toMatchObject({ priority: true });
        expect(await store.getPending()).toHaveLength(1);
        const claimed = (await verificationResultsStore.getAll()).filter(
            (v) => v.batchId === batch.id
        );
        expect(claimed).toHaveLength(1);
    });
});
