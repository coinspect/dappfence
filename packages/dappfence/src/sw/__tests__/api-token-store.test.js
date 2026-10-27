import { describe, it, expect, beforeEach } from 'vitest';
import { createApiTokenStore } from '../storage/api-token-store.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

describe('createApiTokenStore', () => {
    let store;

    beforeEach(() => {
        store = createApiTokenStore(createInMemoryDb());
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
        const store2 = createApiTokenStore(createInMemoryDb());
        const token1 = await store.getApiToken();
        const token2 = await store2.getApiToken();
        // Statistically near-impossible to collide
        expect(token1).not.toBe(token2);
    });
});
