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

    describe('getInstallationTime', () => {
        it('returns a ms timestamp on first call', async () => {
            const t = await store.getInstallationTime();
            expect(typeof t).toBe('number');
            expect(t).toBeGreaterThan(0);
        });

        it('returns the same timestamp on subsequent calls', async () => {
            const t1 = await store.getInstallationTime();
            const t2 = await store.getInstallationTime();
            expect(t1).toBe(t2);
        });

        it('records a different installation time for each database', async () => {
            const t1 = await store.getInstallationTime();
            await new Promise((r) => setTimeout(r, 2));
            const store2 = createSettingsStore(createInMemoryDb());
            const t2 = await store2.getInstallationTime();
            expect(t1).not.toBe(t2);
        });

        it('rehydrates the same installation time from the same database across store instances', async () => {
            const persisted = await store.getInstallationTime();
            const rehydrated = await createSettingsStore(db).getInstallationTime();
            expect(rehydrated).toBe(persisted);
        });
    });

    it('api token and installation time are independent values', async () => {
        const token = await store.getApiToken();
        const installationTime = await store.getInstallationTime();
        expect(token).not.toBe(installationTime);
    });
});
