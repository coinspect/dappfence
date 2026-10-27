/**
 * IndexedDB Storage Module
 * Simple wrapper for IndexedDB operations.
 *
 * createDatabase(idb, {name, version, schema}) returns a db(fn, options) function,
 * making it injectable and testable with in-memory backends.
 */

/**
 * @typedef {{ name: string, keyPath: string, unique?: boolean, multiEntry?: boolean }} IndexSchema
 * @typedef {{ keyPath?: string, autoIncrement?: boolean, indexes?: IndexSchema[] }} StoreSchema
 * @typedef {Record<string, StoreSchema>} Schema
 */

/**
 * @typedef {{
 *   getAll: (query?: IDBValidKey | IDBKeyRange, count?: number) => Promise<any[]>,
 *   count: (query?: IDBValidKey | IDBKeyRange) => Promise<number>,
 *   openCursor: (range?: IDBValidKey | IDBKeyRange, direction?: IDBCursorDirection) => IDBRequest,
 * }} IndexHandle
 *
 * @typedef {{
 *   get: (key: IDBValidKey) => Promise<any>,
 *   put: (value: any, key?: IDBValidKey) => Promise<void>,
 *   add: (value: any, key?: IDBValidKey) => Promise<void>,
 *   delete: (key: IDBValidKey) => Promise<void>,
 *   getAll: (query?: IDBValidKey | IDBKeyRange, count?: number) => Promise<any[]>,
 *   count: (query?: IDBValidKey | IDBKeyRange) => Promise<number>,
 *   index: (indexName: string) => IndexHandle,
 * }} StoreHandle
 *
 * @typedef {Record<string, StoreHandle>} DbScope
 * @typedef {{ mode?: IDBTransactionMode, durability?: IDBTransactionDurability }} DbOptions
 */

/**
 * @typedef {<T>(fn: (scope: DbScope) => Promise<T>, options?: DbOptions) => Promise<T>} Database
 */

/**
 * @param {IDBFactory} idb
 * @param {{ name: string, version: number, schema: Schema }} config
 * @returns {Database}
 */
export function createDatabase(idb, { name, version, schema }) {
    let connectionPromise = null;

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function openConnection() {
        if (connectionPromise) {
            return connectionPromise;
        }
        connectionPromise = new Promise((resolve, reject) => {
            const request = idb.open(name, version);
            request.onerror = () => {
                connectionPromise = null;
                reject(request.error);
            };
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const target = /** @type {IDBOpenDBRequest} */ (e.target);
                const connection = target.result;
                const upgradeTransaction = target.transaction;
                for (const [storeName, config] of Object.entries(schema)) {
                    let store;
                    if (connection.objectStoreNames.contains(storeName)) {
                        store = upgradeTransaction.objectStore(storeName);
                    } else {
                        const createOpts = {};
                        if (config.keyPath !== undefined) {
                            createOpts.keyPath = config.keyPath;
                        }
                        if (config.autoIncrement) {
                            createOpts.autoIncrement = true;
                        }
                        store = connection.createObjectStore(storeName, createOpts);
                    }
                    for (const idx of config.indexes || []) {
                        if (!store.indexNames.contains(idx.name)) {
                            store.createIndex(idx.name, idx.keyPath, {
                                unique: !!idx.unique,
                                multiEntry: !!idx.multiEntry,
                            });
                        }
                    }
                }
            };
        });
        return connectionPromise;
    }

    /**
     * @param {(scope: DbScope) => Promise<any>} fn
     * @param {DbOptions} [options]
     */
    async function db(fn, { mode = 'readonly', durability } = {}) {
        const connection = await openConnection();
        /** @type {IDBTransactionOptions} */
        const nativeOpts = {};
        if (durability) {
            nativeOpts.durability = durability;
        }
        const storeNames = Object.keys(schema);
        const transaction = connection.transaction(storeNames, mode, nativeOpts);
        /** @type {DbScope} */
        const stores = {};
        for (const storeName of storeNames) {
            const objectStore = transaction.objectStore(storeName);
            stores[storeName] = {
                get: (key) => requestToPromise(objectStore.get(key)),
                put: (value, key) =>
                    requestToPromise(
                        key === undefined ? objectStore.put(value) : objectStore.put(value, key)
                    ),
                add: (value, key) =>
                    requestToPromise(
                        key === undefined ? objectStore.add(value) : objectStore.add(value, key)
                    ),
                delete: (key) => requestToPromise(objectStore.delete(key)),
                getAll: (query, count) => requestToPromise(objectStore.getAll(query, count)),
                count: (query) => requestToPromise(objectStore.count(query)),
                index: (indexName) => {
                    const idx = objectStore.index(indexName);
                    return {
                        getAll: (query, count) => requestToPromise(idx.getAll(query, count)),
                        count: (query) => requestToPromise(idx.count(query)),
                        openCursor: (range, direction) => idx.openCursor(range, direction),
                    };
                },
            };
        }
        const ret = await fn(stores);
        transaction.commit();
        await new Promise((resolve, reject) => {
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
        return ret;
    }

    return db;
}
