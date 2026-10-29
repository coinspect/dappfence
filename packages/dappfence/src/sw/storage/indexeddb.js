/**
 * IndexedDB Storage Module
 *
 * createDatabase(idb, {name, version, schema}) returns a DbHandle with
 * read / write / tx methods for scoped transactions.
 */

/**
 * @typedef {{ name: string, keyPath: string, unique?: boolean, multiEntry?: boolean }} IndexSchema
 * @typedef {{ objectStore?: string, primaryKeyPath?: string, autoIncrement?: boolean, indexes?: IndexSchema[] }} StoreSchema
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
 */

/**
 * @typedef {{
 *   read: <K extends keyof DbScope, T>(
 *       stores: readonly K[],
 *       fn: (scope: Pick<DbScope, K>) => Promise<T>
 *   ) => Promise<T>,
 *   write: <K extends keyof DbScope, T>(
 *       stores: readonly K[],
 *       fn: (scope: Pick<DbScope, K>) => Promise<T>
 *   ) => Promise<T>,
 * }} DbHandle
 */

/**
 * @param {IDBOpenDBRequest} request
 * @param {Schema} schema
 */
export function applyMigration(request, schema) {
    const connection = request.result;
    const upgradeTransaction = request.transaction;
    for (const [logicalName, config] of Object.entries(schema)) {
        const objectStoreName = config.objectStore ?? logicalName;
        let store;
        if (connection.objectStoreNames.contains(objectStoreName)) {
            store = upgradeTransaction.objectStore(objectStoreName);
        } else {
            const createOpts = {};
            if (config.primaryKeyPath !== undefined) {
                createOpts.keyPath = config.primaryKeyPath;
            }
            if (config.autoIncrement) {
                createOpts.autoIncrement = true;
            }
            store = connection.createObjectStore(objectStoreName, createOpts);
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
}

/**
 * @param {IDBFactory} idb
 * @param {{ name: string, version: number, schema: Schema }} config
 * @returns {DbHandle}
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
            request.onupgradeneeded = () => applyMigration(request, schema);
        });
        return connectionPromise;
    }

    /**
     * @param {readonly string[]} stores
     * @param {(scope: any) => Promise<any>} fn
     * @param {IDBTransactionMode} mode
     */
    async function tx(stores, fn, mode) {
        const connection = await openConnection();
        const objectStoreNames = stores.map((name) => schema[name].objectStore ?? name);
        const transaction = connection.transaction(objectStoreNames, mode);
        const scope = {};
        for (const logical of stores) {
            const objectStore = transaction.objectStore(schema[logical].objectStore ?? logical);
            scope[logical] = {
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
        const ret = await fn(scope);
        transaction.commit();
        await new Promise((resolve, reject) => {
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
        return ret;
    }

    return {
        read: (stores, fn) => tx(stores, fn, 'readonly'),
        write: (stores, fn) => tx(stores, fn, 'readwrite'),
    };
}
