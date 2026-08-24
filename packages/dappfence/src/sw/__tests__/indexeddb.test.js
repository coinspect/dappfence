import { describe, it, expect } from 'vitest';
import { createDatabase } from '../storage/indexeddb.js';

function makeMockIDB() {
    const store = new Map();

    const makeTransaction = () => {
        const tx = {
            objectStore: () => ({
                get: (key) => {
                    const req = {};
                    Promise.resolve().then(() => {
                        req.result = store.get(key);
                        req.onsuccess?.();
                    });
                    return req;
                },
                put: (value, key) => {
                    const req = {};
                    Promise.resolve().then(() => {
                        store.set(key, value);
                        req.onsuccess?.();
                    });
                    return req;
                },
                delete: (key) => {
                    const req = {};
                    Promise.resolve().then(() => {
                        store.delete(key);
                        req.onsuccess?.();
                    });
                    return req;
                },
            }),
            commit: () => {},
        };
        Object.defineProperty(tx, 'oncomplete', {
            set(fn) {
                Promise.resolve().then(() => fn?.());
            },
            configurable: true,
        });
        return tx;
    };

    const makeDb = () => ({
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => makeTransaction(),
    });

    return {
        open: () => {
            const req = {};
            Promise.resolve().then(() => {
                const db = makeDb();
                req.result = db;
                req.onupgradeneeded?.({ target: { result: db } });
                req.onsuccess?.();
            });
            return req;
        },
        _store: store,
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

function makeMockIDBWithGetError() {
    const makeTransaction = () => {
        const tx = {
            objectStore: () => ({
                get: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        req.error = new Error('get failed');
                        req.onerror?.();
                    });
                    return req;
                },
                put: (value, key) => {
                    const store = new Map();
                    const req = {};
                    Promise.resolve().then(() => {
                        store.set(key, value);
                        req.onsuccess?.();
                    });
                    return req;
                },
            }),
            commit: () => {},
        };
        Object.defineProperty(tx, 'oncomplete', {
            set(fn) {
                Promise.resolve().then(() => fn?.());
            },
            configurable: true,
        });
        return tx;
    };

    const makeDb = () => ({
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => makeTransaction(),
    });

    return {
        open: () => {
            const req = {};
            Promise.resolve().then(() => {
                const db = makeDb();
                req.result = db;
                req.onupgradeneeded?.({ target: { result: db } });
                req.onsuccess?.();
            });
            return req;
        },
    };
}

describe('createDatabase', () => {
    describe('get', () => {
        it('returns stored value for an existing key', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            await db.set('myKey', 'myValue');
            const result = await db.get('myKey');
            expect(result).toBe('myValue');
        });

        it('returns undefined for a missing key', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            const result = await db.get('nonexistent');
            expect(result).toBeUndefined();
        });
    });

    describe('set', () => {
        it('stores a value and allows retrieval', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            await db.set('k', { some: 'data' });
            const result = await db.get('k');
            expect(result).toEqual({ some: 'data' });
        });
    });

    describe('delete', () => {
        it('removes a key from the store', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            await db.set('toDelete', 'value');
            await db.delete('toDelete');
            const result = await db.get('toDelete');
            expect(result).toBeUndefined();
        });
    });

    describe('withTx', () => {
        it('can read and write in one transaction', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            await db.set('initial', 42);

            await db.withTx(async (tx) => {
                const val = await tx.get('initial');
                await tx.set('derived', val * 2);
            });

            const result = await db.get('derived');
            expect(result).toBe(84);
        });

        it('returns the return value of the callback function', async () => {
            const idb = makeMockIDB();
            const db = createDatabase(idb);
            const result = await db.withTx(async () => 'txResult');
            expect(result).toBe('txResult');
        });
    });

    describe('createObjectStore', () => {
        it('calls createObjectStore when data store does not exist', async () => {
            const store = new Map();
            let createObjectStoreCalled = false;

            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        get: (key) => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.result = store.get(key);
                                req.onsuccess?.();
                            });
                            return req;
                        },
                        put: (value, key) => {
                            const req = {};
                            Promise.resolve().then(() => {
                                store.set(key, value);
                                req.onsuccess?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
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
                objectStoreNames: { contains: () => false },
                createObjectStore: () => {
                    createObjectStoreCalled = true;
                },
                transaction: () => makeTransaction(),
            };

            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };

            const database = createDatabase(idb);
            await database.set('key', 'value');
            expect(createObjectStoreCalled).toBe(true);
        });
    });

    describe('error paths', () => {
        it('rejects when idb.open fires onerror', async () => {
            const idb = makeMockIDBWithOpenError();
            const db = createDatabase(idb);
            await expect(db.get('any')).rejects.toThrow('IDB open failed');
        });

        it('rejects withTx when store.get fires onerror', async () => {
            const idb = makeMockIDBWithGetError();
            const db = createDatabase(idb);
            await expect(
                db.withTx(async (tx) => {
                    await tx.get('someKey');
                })
            ).rejects.toThrow('get failed');
        });

        it('rejects get when store.get fires onerror', async () => {
            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        get: () => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.error = new Error('get store error');
                                req.onerror?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
                };
                Object.defineProperty(tx, 'oncomplete', {
                    set(fn) {
                        Promise.resolve().then(() => fn?.());
                    },
                    configurable: true,
                });
                return tx;
            };
            const makeDb = () => ({
                objectStoreNames: { contains: () => true },
                createObjectStore: () => {},
                transaction: () => makeTransaction(),
            });
            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        const db = makeDb();
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };
            const db = createDatabase(idb);
            await expect(db.get('key')).rejects.toThrow('get store error');
        });

        it('rejects set when store.put fires onerror', async () => {
            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        put: () => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.error = new Error('put error');
                                req.onerror?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
                };
                Object.defineProperty(tx, 'oncomplete', {
                    set(fn) {
                        Promise.resolve().then(() => fn?.());
                    },
                    configurable: true,
                });
                return tx;
            };
            const makeDb = () => ({
                objectStoreNames: { contains: () => true },
                createObjectStore: () => {},
                transaction: () => makeTransaction(),
            });
            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        const db = makeDb();
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };
            const db = createDatabase(idb);
            await expect(db.set('key', 'val')).rejects.toThrow('put error');
        });

        it('rejects delete when store.delete fires onerror', async () => {
            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        delete: () => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.error = new Error('delete error');
                                req.onerror?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
                };
                Object.defineProperty(tx, 'oncomplete', {
                    set(fn) {
                        Promise.resolve().then(() => fn?.());
                    },
                    configurable: true,
                });
                return tx;
            };
            const makeDb = () => ({
                objectStoreNames: { contains: () => true },
                createObjectStore: () => {},
                transaction: () => makeTransaction(),
            });
            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        const db = makeDb();
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };
            const db = createDatabase(idb);
            await expect(db.delete('key')).rejects.toThrow('delete error');
        });

        it('rejects withTx when store.put fires onerror', async () => {
            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        get: (_key) => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.result = undefined;
                                req.onsuccess?.();
                            });
                            return req;
                        },
                        put: () => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.error = new Error('tx put error');
                                req.onerror?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
                };
                Object.defineProperty(tx, 'oncomplete', {
                    set(fn) {
                        Promise.resolve().then(() => fn?.());
                    },
                    configurable: true,
                });
                return tx;
            };
            const makeDb = () => ({
                objectStoreNames: { contains: () => true },
                createObjectStore: () => {},
                transaction: () => makeTransaction(),
            });
            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        const db = makeDb();
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };
            const db = createDatabase(idb);
            await expect(
                db.withTx(async (tx) => {
                    await tx.set('key', 'val');
                })
            ).rejects.toThrow('tx put error');
        });

        it('rejects withTx when transaction fires onerror', async () => {
            let triggerTxError;
            const makeTransaction = () => {
                const tx = {
                    objectStore: () => ({
                        get: (_key) => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.result = undefined;
                                req.onsuccess?.();
                            });
                            return req;
                        },
                        put: (_value, _key) => {
                            const req = {};
                            Promise.resolve().then(() => {
                                req.onsuccess?.();
                            });
                            return req;
                        },
                    }),
                    commit: () => {},
                    get onerror() {
                        return undefined;
                    },
                };
                Object.defineProperty(tx, 'oncomplete', {
                    set() {},
                    configurable: true,
                });
                Object.defineProperty(tx, 'onerror', {
                    set(fn) {
                        triggerTxError = () => {
                            tx._txErr = new Error('tx error');
                            fn?.();
                        };
                    },
                    get() {
                        return undefined;
                    },
                    configurable: true,
                });
                Object.defineProperty(tx, 'error', {
                    get() {
                        return tx._txErr;
                    },
                    configurable: true,
                });
                return tx;
            };
            const makeDb = () => ({
                objectStoreNames: { contains: () => true },
                createObjectStore: () => {},
                transaction: () => makeTransaction(),
            });
            const idb = {
                open: () => {
                    const req = {};
                    Promise.resolve().then(() => {
                        const db = makeDb();
                        req.result = db;
                        req.onupgradeneeded?.({ target: { result: db } });
                        req.onsuccess?.();
                    });
                    return req;
                },
            };
            const db = createDatabase(idb);
            const promise = db.withTx(async () => 'done');
            await new Promise((resolve) => setTimeout(resolve, 10));
            triggerTxError?.();
            await expect(promise).rejects.toThrow('tx error');
        });
    });
});
