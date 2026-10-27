import { describe, it, expect } from 'vitest';
import { createDatabase } from '../storage/indexeddb.js';

const STORE_NAMES = ['manifests', 'activeBlocks', 'settings', 'verificationResults'];
const TEST_CONFIG = {
    name: 'TestDB',
    version: 1,
    schema: Object.fromEntries(STORE_NAMES.map((n) => [n, {}])),
};

function makeMockIDB(opts = {}) {
    const stores = Object.fromEntries(STORE_NAMES.map((n) => [n, new Map()]));
    const trace = { opens: 0, transactions: [], createdStores: [] };
    const hooks = opts.hooks || {};

    const makeReq = (producer) => {
        const req = {};
        Promise.resolve().then(() => {
            try {
                req.result = producer();
                req.onsuccess?.();
            } catch (e) {
                req.error = e;
                req.onerror?.();
            }
        });
        return req;
    };

    const makeObjectStore = (name) => {
        const data = stores[name];
        return {
            get indexNames() {
                return { contains: () => false };
            },
            createIndex: () => {},
            get(key) {
                return makeReq(() => {
                    hooks.onGet?.(name, key);
                    return data.get(key);
                });
            },
            put(value, key) {
                return makeReq(() => {
                    hooks.onPut?.(name, value, key);
                    data.set(key, value);
                });
            },
            delete(key) {
                return makeReq(() => {
                    data.delete(key);
                });
            },
            getAll(_range, count) {
                return makeReq(() => {
                    const all = Array.from(data.values());
                    return count !== undefined ? all.slice(0, count) : all;
                });
            },
            count() {
                return makeReq(() => data.size);
            },
        };
    };

    const makeTransaction = (storeNames, mode, options = {}) => {
        trace.transactions.push({ storeNames: [...storeNames], mode, options });
        const tx = {
            objectStore: (name) => makeObjectStore(name),
            commit: () => {},
            mode,
        };
        Object.defineProperty(tx, 'oncomplete', {
            set(fn) {
                Promise.resolve().then(() => fn?.());
            },
            configurable: true,
        });
        return tx;
    };

    const db = {
        objectStoreNames: { contains: (name) => trace.createdStores.includes(name) },
        createObjectStore: (name) => {
            trace.createdStores.push(name);
            return makeObjectStore(name);
        },
        transaction: (storeNames, mode, options) => {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            return makeTransaction(names, mode, options);
        },
    };

    return {
        open: () => {
            trace.opens++;
            const req = {};
            Promise.resolve().then(() => {
                req.result = db;
                const upgradeTx = { objectStore: (name) => makeObjectStore(name) };
                req.onupgradeneeded?.({ target: { result: db, transaction: upgradeTx } });
                req.onsuccess?.();
            });
            return req;
        },
        _trace: trace,
        _stores: stores,
    };
}

function makeMockIDBWithOpenError() {
    return {
        open: () => {
            const req = {};
            Promise.resolve().then(() => {
                req.error = new Error('IDB open failed');
                req.onerror?.();
            });
            return req;
        },
    };
}

describe('createDatabase', () => {
    describe('schema application', () => {
        it('creates every store declared in the schema on first open', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async ({ manifests }) => manifests.get('x'));
            for (const name of STORE_NAMES) {
                expect(idb._trace.createdStores).toContain(name);
            }
        });
    });

    describe('persistent connection', () => {
        it('opens the database only once across many transactions', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async ({ manifests }) => manifests.get('a'));
            await db(async ({ manifests }) => manifests.get('b'));
            await db(async ({ settings }) => settings.get('t'), { mode: 'readwrite' });
            expect(idb._trace.opens).toBe(1);
        });
    });

    describe('tx shape', () => {
        it('defaults mode to readonly', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async () => {});
            expect(idb._trace.transactions.at(-1).mode).toBe('readonly');
        });

        it('propagates mode when passed', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async () => {}, { mode: 'readwrite' });
            expect(idb._trace.transactions.at(-1).mode).toBe('readwrite');
        });

        it('passes durability through to IndexedDB', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async () => {}, { mode: 'readwrite', durability: 'relaxed' });
            expect(idb._trace.transactions.at(-1).options.durability).toBe('relaxed');
        });

        it('scope includes every schema store', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb, TEST_CONFIG);
            await db(async (scope) => {
                for (const name of STORE_NAMES) {
                    expect(scope[name]).toBeDefined();
                    expect(typeof scope[name].get).toBe('function');
                }
            });
        });

        it('returns the callback return value', async () => {
            const db = createDatabase(makeMockIDB(), TEST_CONFIG);
            const result = await db(async () => 'ok');
            expect(result).toBe('ok');
        });

        it('round-trips a value through put + get on a single store', async () => {
            const db = createDatabase(makeMockIDB(), TEST_CONFIG);
            await db(async ({ manifests }) => manifests.put({ v: 1 }, 'k'), {
                mode: 'readwrite',
            });
            const got = await db(({ manifests }) => manifests.get('k'));
            expect(got).toEqual({ v: 1 });
        });
    });

    describe('error paths', () => {
        it('rejects when idb.open fires onerror', async () => {
            const db = createDatabase(makeMockIDBWithOpenError(), TEST_CONFIG);
            await expect(db(({ manifests }) => manifests.get('x'))).rejects.toThrow(
                'IDB open failed'
            );
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
            await expect(db(({ manifests }) => manifests.get('x'))).rejects.toThrow('get failed');
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
                db(({ manifests }) => manifests.put('v', 'k'), { mode: 'readwrite' })
            ).rejects.toThrow('put failed');
        });
    });
});
