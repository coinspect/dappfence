import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelemetryBatchesStore } from '../storage/telemetry-batches-store.js';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';
import { withTransactionLifetime } from './helpers/transaction-lifetime.js';

const batch = (overrides = {}) => ({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    events: [],
    priority: false,
    ...overrides,
});

describe('createTelemetryBatchesStore', () => {
    let store;

    beforeEach(() => {
        store = createTelemetryBatchesStore(createInMemoryDb());
    });

    it('add + get round-trips a batch', async () => {
        const b = batch({ events: [{ status: 'MATCH' }], priority: true });
        await store.add(b);
        expect(await store.get(b.id)).toMatchObject({
            id: b.id,
            events: [{ status: 'MATCH' }],
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
        // In a browser, crypto.subtle.digest resolves on a later task. Node's
        // can win the race against a 0ms timer, so pin it to a macrotask.
        const realDigest = crypto.subtle.digest.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
            await new Promise((r) => setTimeout(r, 5));
            return realDigest(...args);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('helper sanity: IDB-only transactions still commit', async () => {
        const b = batch();
        await store.add(b);
        await store.markSent([b.id]);
        expect(typeof (await store.get(b.id)).sentAt).toBe('number');
    });

    it('claimUnclaimed assembles a batch without awaiting non-IDB work mid-transaction', async () => {
        await verificationResultsStore.add({
            status: VERIFICATION_STATUS.FILE_UNTRUSTED,
            fileKey: '/app.js',
            manifestInfo: { appVersion: 'v1' },
        });

        const claimed = await store.createBatch((unclaimed) => unclaimed);

        expect(claimed).toMatchObject({ priority: true });
        expect(await store.getPending()).toHaveLength(1);
    });
});
