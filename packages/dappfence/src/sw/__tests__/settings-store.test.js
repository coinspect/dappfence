import { describe, it, expect, beforeEach } from 'vitest';
import { createSettingsStore } from '../storage/settings-store.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

describe('createSettingsStore', () => {
    let store;
    let db;

    beforeEach(() => {
        db = createInMemoryDb();
        store = createSettingsStore(db);
    });

    describe('getApiToken', () => {
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
            const store2 = createSettingsStore(createInMemoryDb());
            const token1 = await store.getApiToken();
            const token2 = await store2.getApiToken();
            expect(token1).not.toBe(token2);
        });

        it('rehydrates the same token from the same database across store instances', async () => {
            const persisted = await store.getApiToken();
            const rehydrated = await createSettingsStore(db).getApiToken();
            expect(rehydrated).toBe(persisted);
        });
    });

    describe('getSessionId', () => {
        it('generates a UUID v4 on first call', async () => {
            const id = await store.getSessionId();
            expect(id).toMatch(/^[0-9a-f-]{36}$/);
        });

        it('returns the same session id on subsequent calls', async () => {
            const id1 = await store.getSessionId();
            const id2 = await store.getSessionId();
            expect(id1).toBe(id2);
        });

        it('generates different session ids for different databases', async () => {
            const store2 = createSettingsStore(createInMemoryDb());
            const id1 = await store.getSessionId();
            const id2 = await store2.getSessionId();
            expect(id1).not.toBe(id2);
        });

        it('rehydrates the same session id from the same database across store instances', async () => {
            const persisted = await store.getSessionId();
            const rehydrated = await createSettingsStore(db).getSessionId();
            expect(rehydrated).toBe(persisted);
        });
    });

    it('api token and session id are independent values', async () => {
        const token = await store.getApiToken();
        const sessionId = await store.getSessionId();
        expect(token).not.toBe(sessionId);
    });
});
