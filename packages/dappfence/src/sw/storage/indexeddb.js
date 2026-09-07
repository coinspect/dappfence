/**
 * IndexedDB Storage Module
 * Simple wrapper for IndexedDB operations.
 *
 * createDatabase() returns an instance with { get, set, delete, withTx },
 * making it injectable and testable with in-memory backends.
 */

export function createDatabase(idb) {
    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = idb.open('AppSecurity', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('data')) {
                    db.createObjectStore('data');
                }
            };
        });
    }

    async function get(key) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['data'], 'readonly');
            const request = transaction.objectStore('data').get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Run a function inside an IndexedDB transaction
    async function withTx(func) {
        const db = await openDatabase();
        const transaction = db.transaction(['data'], 'readwrite');
        const store = transaction.objectStore('data');
        const ret = await func({
            get: async (key) => {
                return new Promise((resolve, reject) => {
                    const request = store.get(key);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            },
            set: async (key, value) => {
                return new Promise((resolve, reject) => {
                    const request = store.put(value, key);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve();
                });
            },
        });
        transaction.commit();
        await new Promise((resolve, reject) => {
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
        });
        return ret;
    }

    // TODO: Search and replace the usage of set by update
    async function set(key, value) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['data'], 'readwrite');
            const request = transaction.objectStore('data').put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async function del(key) {
        const db = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(['data'], 'readwrite');
            const request = transaction.objectStore('data').delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    return { get, set, delete: del, withTx };
}
