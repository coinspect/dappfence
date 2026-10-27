import { describe, it, expect } from 'vitest';
import { createAppStoreFromDb } from '../storage/index.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

describe('createAppStore', () => {
    it('returns all expected store properties', () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());

        expect(appStore.trustedManifestStore).toBeDefined();
        expect(appStore.verificationResultsStore).toBeDefined();
        expect(appStore.securityStore).toBeDefined();
        expect(appStore.settingsStore).toBeDefined();
    });

    it('manifest stores are functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const { appVersion } = await appStore.trustedManifestStore.addLatest({
            files: { '/a.js': 'h' },
        });
        const latest = await appStore.trustedManifestStore.getLatest();
        expect(latest.appVersion).toBe(appVersion);
    });

    it('security store is functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const blocks = await appStore.securityStore.getActiveBlocks();
        expect(blocks).toEqual([]);
    });

    it('settings store is functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const token = await appStore.settingsStore.getApiToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        const sessionId = await appStore.settingsStore.getSessionId();
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });
});
