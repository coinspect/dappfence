import { describe, it, expect } from 'vitest';
import { createAppStore } from '../storage/index.js';

function createInMemoryDatabase() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        delete: async (key) => store.delete(key),
        withTx: async (fn) => {
            const result = await fn({
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
            });
            return result;
        },
    };
}

describe('createAppStore', () => {
    it('returns all expected store properties', () => {
        const appStore = createAppStore(createInMemoryDatabase());

        expect(appStore.trustedManifestStore).toBeDefined();
        expect(appStore.verificationResultsStore).toBeDefined();
        expect(appStore.activeBlocksStore).toBeDefined();
        expect(appStore.securityEventsStore).toBeDefined();
        expect(appStore.apiTokenStore).toBeDefined();
    });

    it('manifest stores are functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const { appVersion } = await appStore.trustedManifestStore.addLatest(
            { files: { '/a.js': 'h' } },
            { signatureType: 'ethereum-personal-sign', identity: '0xmocksigner' }
        );
        const latest = await appStore.trustedManifestStore.getLatest();
        expect(latest.appVersion).toBe(appVersion);
    });

    it('active blocks store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const blocks = await appStore.activeBlocksStore.getActiveBlocks();
        expect(blocks).toEqual([]);
    });

    it('security events store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events).toEqual([]);
    });

    it('api token store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const token = await appStore.apiTokenStore.getApiToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
});
