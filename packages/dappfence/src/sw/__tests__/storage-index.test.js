import { describe, it, expect } from 'vitest';
import { createAppStoreFromDb } from '../storage/index.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

describe('createAppStore', () => {
    it('returns all expected store properties', () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());

        expect(appStore.trustedManifestStore).toBeDefined();
        expect(appStore.verificationResultsStore).toBeDefined();
        expect(appStore.activeBlocksStore).toBeDefined();
        expect(appStore.apiTokenStore).toBeDefined();
    });

    it('manifest stores are functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const { appVersion } = await appStore.trustedManifestStore.addLatest({
            files: { '/a.js': 'h' },
        });
        const latest = await appStore.trustedManifestStore.getLatest();
        expect(latest.appVersion).toBe(appVersion);
    });

    it('active blocks store is functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const blocks = await appStore.activeBlocksStore.getActiveBlocks();
        expect(blocks).toEqual([]);
    });

    it('api token store is functional', async () => {
        const appStore = createAppStoreFromDb(createInMemoryDb());
        const token = await appStore.apiTokenStore.getApiToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
});
