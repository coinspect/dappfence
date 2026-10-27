/**
 * IndexedDB Storage Module
 *
 * createDatabase(idb, {name, version, schema}) returns a DbHandle with
 * read / write / tx methods for scoped transactions.
 */

/**
 * @typedef {{ name: string, keyPath: string | string[], unique?: boolean, multiEntry?: boolean }} IndexSchema
 * @typedef {{ objectStore?: string, primaryKeyPath?: string, autoIncrement?: boolean, indexes?: IndexSchema[] }} StoreSchema
 * @typedef {Record<string, StoreSchema>} Schema
 */

/**
 * Range descriptor used in place of IDBKeyRange so caller code stays free of
 * IDB-world globals. The wrapper translates to a real IDBKeyRange before
 * calling native IDB; the in-memory test mock reads `lower`/`upper` directly.
 * @typedef {{ lower?: IDBValidKey, upper?: IDBValidKey, lowerOpen?: boolean, upperOpen?: boolean }} RangeDesc
 *
 * @typedef {{ query?: IDBValidKey | RangeDesc, count?: number, direction?: IDBCursorDirection }} GetAllOptions
 *
 * @typedef {{
 *   getAll: (options?: GetAllOptions) => Promise<any[]>,
 *   count: (query?: IDBValidKey | RangeDesc) => Promise<number>,
 *   openCursor: (range?: IDBValidKey | RangeDesc, direction?: IDBCursorDirection) => IDBRequest,
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

    function toIDBKeyRange(query) {
        if (query === undefined || query === null) {
            return undefined;
        }
        if (query instanceof IDBKeyRange) {
            return query;
        }
        if (typeof query !== 'object' || Array.isArray(query)) {
            return query;
        }
        const { lower, upper, lowerOpen = false, upperOpen = false } = query;
        if (lower !== undefined && upper !== undefined) {
            return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
        }
        if (lower !== undefined) {
            return IDBKeyRange.lowerBound(lower, lowerOpen);
        }
        if (upper !== undefined) {
            return IDBKeyRange.upperBound(upper, upperOpen);
        }
        return undefined;
    }

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
            request.onsuccess = () => {
                const db = request.result;
                // Browser closes the handle on SW termination, versionchange (another
                // SW opening the DB at a higher version), or forced close. Invalidate
                // the cached promise so the next tx re-opens a fresh connection.
                db.onversionchange = () => {
                    db.close?.();
                    connectionPromise = null;
                };
                db.onclose = () => {
                    connectionPromise = null;
                };
                resolve(db);
            };
            request.onupgradeneeded = () => applyMigration(request, schema);
        });
        return connectionPromise;
    }

    async function runTx(connection, stores, fn, mode) {
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
                getAll: (query, count) =>
                    requestToPromise(objectStore.getAll(toIDBKeyRange(query), count)),
                count: (query) => requestToPromise(objectStore.count(toIDBKeyRange(query))),
                index: (indexName) => {
                    const idx = objectStore.index(indexName);
                    return {
                        getAll: (options) => {
                            const nativeOptions = options
                                ? { ...options, query: toIDBKeyRange(options.query) }
                                : undefined;
                            return requestToPromise(idx.getAll(nativeOptions));
                        },
                        count: (query) => requestToPromise(idx.count(toIDBKeyRange(query))),
                        openCursor: (range, direction) =>
                            idx.openCursor(toIDBKeyRange(range), direction),
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

    /**
     * @param {readonly string[]} stores
     * @param {(scope: any) => Promise<any>} fn
     * @param {IDBTransactionMode} mode
     *
     * Retries once on InvalidStateError to cover the race where the browser
     * closes the connection between `openConnection()` resolving and
     * `connection.transaction(...)` being called (onversionchange handler
     * fires too late to help the in-flight tx).
     */
    async function tx(stores, fn, mode) {
        try {
            return await runTx(await openConnection(), stores, fn, mode);
        } catch (err) {
            if (err?.name === 'InvalidStateError') {
                connectionPromise = null;
                return await runTx(await openConnection(), stores, fn, mode);
            }
            throw err;
        }
    }

    return {
        read: (stores, fn) => tx(stores, fn, 'readonly'),
        write: (stores, fn) => tx(stores, fn, 'readwrite'),
    };
}
