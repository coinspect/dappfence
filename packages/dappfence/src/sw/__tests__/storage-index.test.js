import { describe, it, expect } from 'vitest';
import { createAppStore, createAppStoreFromDb } from '../storage/index.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';
import { makeMockIDB } from './helpers/mock-idb.js';

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
        const installationTime = await appStore.settingsStore.getInstallationTime();
        expect(typeof installationTime).toBe('number');
    });

    describe('upgrading an existing database', () => {
        // Exercises the real NAME/VERSION/SCHEMA rather than an injected db, so
        // the shipped schema version is what's under test.
        const asLeftBy0_1_x = () => makeMockIDB({ existing: { version: 1, stores: ['data'] } });

        it('creates the current stores over the 0.1.x single-store layout', async () => {
            const idb = asLeftBy0_1_x();
            const appStore = createAppStore(idb);
            const token = await appStore.settingsStore.getApiToken();

            expect(token).toMatch(/^[0-9a-f]{64}$/);
            expect(idb._trace.createdStores).toEqual(
                expect.arrayContaining([
                    'manifests',
                    'activeBlocks',
                    'settings',
                    'verificationResults',
                ])
            );
        });

        it('every store is usable after the upgrade', async () => {
            const appStore = createAppStore(asLeftBy0_1_x());

            await appStore.trustedManifestStore.addLatest({ files: { '/a.js': 'h' } });
            expect(await appStore.trustedManifestStore.getLatest()).toBeDefined();
            expect(await appStore.securityStore.getActiveBlocks()).toEqual([]);
            expect(await appStore.verificationResultsStore.get('1.0.0')).toEqual([]);
            expect(typeof (await appStore.settingsStore.getInstallationTime())).toBe('number');
        });

        it('a fresh install still gets every store', async () => {
            const idb = makeMockIDB();
            const appStore = createAppStore(idb);

            expect(await appStore.settingsStore.getApiToken()).toMatch(/^[0-9a-f]{64}$/);
            expect(idb._trace.upgrades).toHaveLength(1);
            expect(idb._trace.upgrades[0].from).toBe(0);
            // Has to stay past 1, or an install still holding the 0.1.x
            // database never migrates off the old single-store layout.
            expect(idb._trace.upgrades[0].to).toBeGreaterThan(1);
        });
    });
});
