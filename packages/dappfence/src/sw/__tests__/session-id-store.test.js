import { describe, it, expect, beforeEach } from 'vitest';
import { createSessionIdStore } from '../storage/security-stores.js';

function createInMemoryDatabase() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        withTx: async (fn) => {
            const result = await fn({
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
            });
            return result;
        },
    };
}

describe('createSessionIdStore', () => {
    let store;

    beforeEach(() => {
        store = createSessionIdStore(createInMemoryDatabase());
    });

    it('generates a UUID v4 on first call', async () => {
        const id = await store.getSessionId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('returns the same id on subsequent calls', async () => {
        const id1 = await store.getSessionId();
        const id2 = await store.getSessionId();
        expect(id1).toBe(id2);
    });

    it('generates different ids for different store instances', async () => {
        const store2 = createSessionIdStore(createInMemoryDatabase());
        const id1 = await store.getSessionId();
        const id2 = await store2.getSessionId();
        expect(id1).not.toBe(id2);
    });

    it('rehydrates from persisted value across store instances sharing a database', async () => {
        const database = createInMemoryDatabase();
        const first = createSessionIdStore(database);
        const persisted = await first.getSessionId();
        const second = createSessionIdStore(database);
        const rehydrated = await second.getSessionId();
        expect(rehydrated).toBe(persisted);
    });
});
