import { describe, it, expect } from 'vitest';
import {
    createAppStore,
    createAppStoreFromDb,
    HISTORICAL_SCHEMAS,
    SCHEMA,
    VERSION,
} from '../storage/index.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';
import { makeMockIDB } from './helpers/mock-idb.js';

const HISTORICAL_VERSIONS = Object.keys(HISTORICAL_SCHEMAS).map(Number);

const physicalStoresOf = (schema) =>
    Object.entries(schema).map(([logical, config]) => config.objectStore ?? logical);

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

describe('schema evolution', () => {
    it('VERSION equals the highest HISTORICAL_SCHEMAS key', () => {
        expect(Math.max(...HISTORICAL_VERSIONS)).toBe(VERSION);
    });

    it('SCHEMA deep-equals HISTORICAL_SCHEMAS[VERSION]', () => {
        expect(SCHEMA).toEqual(HISTORICAL_SCHEMAS[VERSION]);
    });

    it('HISTORICAL_SCHEMAS is contiguous from 0 to VERSION', () => {
        for (let v = 0; v <= VERSION; v++) {
            expect(HISTORICAL_SCHEMAS[v], `missing HISTORICAL_SCHEMAS[${v}] fixture`).toBeDefined();
        }
    });

    it('current SCHEMA does not clash with any historical shape at the same physical name', () => {
        for (const [v, historical] of Object.entries(HISTORICAL_SCHEMAS)) {
            if (Number(v) === VERSION) {
                continue; // same as current — nothing to compare
            }
            for (const [logical, currentConfig] of Object.entries(SCHEMA)) {
                const currentPhysical = currentConfig.objectStore ?? logical;
                const historicalEntry = historical[logical];
                if (!historicalEntry) {
                    continue;
                }
                const historicalPhysical = historicalEntry.objectStore ?? logical;
                if (currentPhysical !== historicalPhysical) {
                    continue;
                }
                expect(
                    currentConfig.primaryKeyPath,
                    `v${v}.${logical}: primaryKeyPath changed but objectStore was not renamed`
                ).toBe(historicalEntry.primaryKeyPath);
                expect(
                    !!currentConfig.autoIncrement,
                    `v${v}.${logical}: autoIncrement changed but objectStore was not renamed`
                ).toBe(!!historicalEntry.autoIncrement);
            }
        }
    });
});

describe('createAppStore schema migrations', () => {
    for (const v of HISTORICAL_VERSIONS.filter((n) => n < VERSION)) {
        describe(`from v${v} to v${VERSION}`, () => {
            const existing = { version: v, stores: physicalStoresOf(HISTORICAL_SCHEMAS[v]) };

            it('creates every current SCHEMA object store', async () => {
                const idb = makeMockIDB({ existing });
                const appStore = createAppStore(idb);
                await appStore.settingsStore.getApiToken();

                for (const [logical, config] of Object.entries(SCHEMA)) {
                    const physical = config.objectStore ?? logical;
                    const stillHere =
                        idb._trace.createdStores.includes(physical) ||
                        existing.stores.includes(physical);
                    expect(stillHere).toBe(true);
                }
            });

            it('preserves orphan stores from the old schema', async () => {
                const idb = makeMockIDB({ existing });
                const appStore = createAppStore(idb);
                await appStore.settingsStore.getApiToken();

                const currentPhysicals = new Set(
                    Object.entries(SCHEMA).map(([logical, config]) => config.objectStore ?? logical)
                );
                for (const orphan of existing.stores) {
                    if (!currentPhysicals.has(orphan)) {
                        expect(idb._trace.createdStores).not.toContain(orphan);
                    }
                }
            });

            it('every current store is usable after the upgrade', async () => {
                const idb = makeMockIDB({ existing });
                const appStore = createAppStore(idb);

                await appStore.trustedManifestStore.addLatest({ files: { '/a.js': 'h' } });
                expect(await appStore.trustedManifestStore.getLatest()).toBeDefined();
                expect(await appStore.securityStore.getActiveBlocks()).toEqual([]);
                expect(typeof (await appStore.settingsStore.getInstallationTime())).toBe('number');
            });
        });
    }
});
