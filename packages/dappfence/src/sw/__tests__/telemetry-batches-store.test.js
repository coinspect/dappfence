import { describe, it, expect, beforeEach } from 'vitest';
import { createTelemetryBatchesStore } from '../storage/telemetry-batches-store.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

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
