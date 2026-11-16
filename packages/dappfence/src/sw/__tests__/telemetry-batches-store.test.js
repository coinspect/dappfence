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

    it('markSent stamps sentAt on every id in one tx', async () => {
        const b1 = batch();
        const b2 = batch();
        await store.add(b1);
        await store.add(b2);
        await store.markSent([b1.id, b2.id]);
        const after1 = await store.get(b1.id);
        const after2 = await store.get(b2.id);
        expect(typeof after1.sentAt).toBe('number');
        expect(after1.sentAt).toBe(after2.sentAt);
    });

    it('markSent is a no-op for empty list', async () => {
        await expect(store.markSent([])).resolves.toBeUndefined();
    });

    it('markSent skips unknown ids and still stamps known ones', async () => {
        const b = batch();
        await store.add(b);
        await store.markSent(['ghost', b.id]);
        const after = await store.get(b.id);
        expect(typeof after.sentAt).toBe('number');
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

    it('helper sanity: IDB-only transactions still commit', async () => {
        const b = batch();
        await store.add(b);
        await store.markSent([b.id]);
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
