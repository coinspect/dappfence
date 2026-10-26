import { describe, it, expect, beforeEach } from 'vitest';
import { createApiTokenStore } from '../storage/api-token-store.js';

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

describe('createApiTokenStore', () => {
    let store;

    beforeEach(() => {
        store = createApiTokenStore(createInMemoryDatabase());
    });

    it('generates a hex token on first call', async () => {
        const token = await store.getApiToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same token on subsequent calls', async () => {
        const token1 = await store.getApiToken();
        const token2 = await store.getApiToken();
        expect(token1).toBe(token2);
    });

    it('generates different tokens for different store instances', async () => {
        const store2 = createApiTokenStore(createInMemoryDatabase());
        const token1 = await store.getApiToken();
        const token2 = await store2.getApiToken();
        // Statistically near-impossible to collide
        expect(token1).not.toBe(token2);
    });
});
