/**
 * Minimal in-process stand-in for IDBFactory, faithful on the two points that
 * matter for schema correctness:
 *
 *   1. `onupgradeneeded` fires only when the requested version is higher than
 *      the one already stored. Opening at the same version runs no migration —
 *      which is how a renamed object store can silently go missing for someone
 *      who already has the database.
 *   2. A transaction naming a store the database doesn't hold throws
 *      NotFoundError, the way a real browser does, instead of quietly
 *      materializing it.
 *
 * Pass `existing` to start from a database a previous release left behind:
 * `{ version: 1, stores: ['data'] }`.
 */

// Stub IDBKeyRange so the real indexeddb.js wrapper's `toIDBKeyRange` doesn't
// ReferenceError under vitest. The mock treats ranges as opaque — index.getAll
// returns all stored values and lets individual tests assert what matters.
if (typeof globalThis.IDBKeyRange === 'undefined') {
    // Must be a constructor function — the wrapper does `query instanceof IDBKeyRange`.
    globalThis.IDBKeyRange = function MockIDBKeyRange() {};
    globalThis.IDBKeyRange.bound = (lower, upper, lowerOpen, upperOpen) =>
        Object.assign(new globalThis.IDBKeyRange(), { lower, upper, lowerOpen, upperOpen });
    globalThis.IDBKeyRange.lowerBound = (lower, open) =>
        Object.assign(new globalThis.IDBKeyRange(), { lower, lowerOpen: open });
    globalThis.IDBKeyRange.upperBound = (upper, open) =>
        Object.assign(new globalThis.IDBKeyRange(), { upper, upperOpen: open });
}

/**
 * @param {{ hooks?: object, existing?: { version: number, stores: string[] } | null }} [opts]
 */
export function makeMockIDB({ hooks = {}, existing = null } = {}) {
    /** @type {Map<string, Map<any, any>>} */
    const stores = new Map((existing?.stores ?? []).map((name) => [name, new Map()]));
    let storedVersion = existing?.version ?? 0;

    const trace = { opens: 0, transactions: [], createdStores: [], upgrades: [] };

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
        const data = stores.get(name);
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
            add(value, key) {
                return makeReq(() => {
                    if (data.has(key)) {
                        throw new Error('ConstraintError');
                    }
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
            index(_name) {
                return {
                    getAll(nativeOptions) {
                        return makeReq(() => {
                            const all = Array.from(data.values());
                            return nativeOptions?.count !== undefined
                                ? all.slice(0, nativeOptions.count)
                                : all;
                        });
                    },
                    count() {
                        return makeReq(() => data.size);
                    },
                };
            },
        };
    };

    const makeTransaction = (storeNames, mode, options = {}) => {
        for (const name of storeNames) {
            if (!stores.has(name)) {
                const error = new Error(
                    `NotFoundError: object store '${name}' not found in the database`
                );
                error.name = 'NotFoundError';
                throw error;
            }
        }
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
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore: (name) => {
            stores.set(name, new Map());
            trace.createdStores.push(name);
            return makeObjectStore(name);
        },
        transaction: (storeNames, mode, options) =>
            makeTransaction(Array.isArray(storeNames) ? storeNames : [storeNames], mode, options),
    };

    return {
        open: (_name, version = 1) => {
            trace.opens++;
            const req = {};
            Promise.resolve().then(() => {
                if (version < storedVersion) {
                    const error = new Error(
                        `VersionError: requested version ${version} is less than ${storedVersion}`
                    );
                    error.name = 'VersionError';
                    req.error = error;
                    req.onerror?.();
                    return;
                }
                req.result = db;
                if (version > storedVersion) {
                    trace.upgrades.push({ from: storedVersion, to: version });
                    storedVersion = version;
                    const upgradeTx = { objectStore: (name) => makeObjectStore(name) };
                    req.transaction = upgradeTx;
                    req.onupgradeneeded?.({ target: { result: db, transaction: upgradeTx } });
                    req.transaction = null;
                }
                req.onsuccess?.();
            });
            return req;
        },
        _trace: trace,
        _stores: stores,
    };
}

export function makeMockIDBWithOpenError() {
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
