import { describe, it, expect } from 'vitest';
import { createDatabase } from '../storage/indexeddb.js';
import { makeMockIDB, makeMockIDBWithOpenError } from './helpers/mock-idb.js';

const STORE_NAMES = ['manifests', 'activeBlocks', 'settings', 'verificationResults'];
const TEST_CONFIG = {
    name: 'TestDB',
    version: 1,
    schema: Object.fromEntries(STORE_NAMES.map((n) => [n, {}])),
};

describe('createDatabase', () => {
    describe('schema application', () => {
        it('creates every store declared in the schema on first open', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.read(['manifests'], ({ manifests }) => manifests.get('x'));
            for (const name of STORE_NAMES) {
                expect(idb._trace.createdStores).toContain(name);
            }
        });

        it('creates stores missing from a database left by an older schema', async () => {
            // The 0.1.x layout: same database name, one catch-all 'data' store.
            const idb = makeMockIDB({ existing: { version: 1, stores: ['data'] } });
            const db = createDatabase(idb, { ...TEST_CONFIG, version: 2 });
            await db.read(['manifests'], ({ manifests }) => manifests.get('x'));
            for (const name of STORE_NAMES) {
                expect(idb._trace.createdStores).toContain(name);
            }
        });

        it('cannot create stores when the version is not raised past the stored one', async () => {
            // Guards the actual defect: reusing the stored version skips
            // onupgradeneeded, so a renamed store is never created and the
            // first transaction naming it fails.
            const idb = makeMockIDB({ existing: { version: 1, stores: ['data'] } });
            const db = createDatabase(idb, { ...TEST_CONFIG, version: 1 });
            await expect(
                db.read(['manifests'], ({ manifests }) => manifests.get('x'))
            ).rejects.toThrow(/NotFoundError/);
            expect(idb._trace.upgrades).toEqual([]);
        });
    });

    describe('persistent connection', () => {
        it('opens the database only once across many transactions', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.read(['manifests'], ({ manifests }) => manifests.get('a'));
            await db.read(['manifests'], ({ manifests }) => manifests.get('b'));
            await db.write(['settings'], ({ settings }) => settings.put('v', 't'));
            expect(idb._trace.opens).toBe(1);
        });
    });

    describe('tx shape', () => {
        it('opens a readonly transaction via read()', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.read(['manifests'], async () => {});
            expect(idb._trace.transactions.at(-1).mode).toBe('readonly');
        });

        it('opens a readwrite transaction via write()', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.write(['manifests'], async () => {});
            expect(idb._trace.transactions.at(-1).mode).toBe('readwrite');
        });

        it('scopes the transaction to the listed stores only', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.read(['manifests', 'settings'], async () => {});
            expect(idb._trace.transactions.at(-1).storeNames).toEqual(['manifests', 'settings']);
        });

        it('exposes only the listed stores on the scope', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db.read(['manifests'], async (scope) => {
                expect(scope.manifests).toBeDefined();
                expect(scope.settings).toBeUndefined();
                expect(scope.activeBlocks).toBeUndefined();
            });
        });

        it('returns the callback return value', async () => {
            const db = createDatabase(makeMockIDB(), TEST_CONFIG);
            const result = await db.read(['manifests'], async () => 'ok');
            expect(result).toBe('ok');
        });

        it('round-trips a value through put + get on a single store', async () => {
            const db = createDatabase(makeMockIDB(), TEST_CONFIG);
            await db.write(['manifests'], ({ manifests }) => manifests.put({ v: 1 }, 'k'));
            const got = await db.read(['manifests'], ({ manifests }) => manifests.get('k'));
            expect(got).toEqual({ v: 1 });
        });
    });

    describe('error paths', () => {
        it('rejects when idb.open fires onerror', async () => {
            const db = createDatabase(makeMockIDBWithOpenError(), TEST_CONFIG);
            await expect(
                db.read(['manifests'], ({ manifests }) => manifests.get('x'))
            ).rejects.toThrow('IDB open failed');
        });

        it('rejects when store.get throws', async () => {
            const idb = makeMockIDB({
                hooks: {
                    onGet: () => {
                        throw new Error('get failed');
                    },
                },
            });
            const db = createDatabase(idb, TEST_CONFIG);
            await expect(
                db.read(['manifests'], ({ manifests }) => manifests.get('x'))
            ).rejects.toThrow('get failed');
        });

        it('rejects when store.put throws', async () => {
            const idb = makeMockIDB({
                hooks: {
                    onPut: () => {
                        throw new Error('put failed');
                    },
                },
            });
            const db = createDatabase(idb, TEST_CONFIG);
            await expect(
                db.write(['manifests'], ({ manifests }) => manifests.put('v', 'k'))
            ).rejects.toThrow('put failed');
        });
    });
});
