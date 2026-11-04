/**
 * Wraps a DbHandle (e.g. createInMemoryDb()) so transactions follow the real
 * IndexedDB lifetime rule the in-memory mock ignores: a transaction is only
 * active while the code inside it chains IDB requests. Once control returns
 * to the event loop with no request in flight, the browser auto-commits it,
 * and any later request on it throws TransactionInactiveError.
 *
 * Model: the in-memory handles resolve on microtasks, so a callback that only
 * awaits IDB requests finishes before any macrotask runs. The first macrotask
 * after the transaction starts marks it inactive. Awaiting anything that
 * resolves on a later task (fetch, timers, crypto.subtle in a browser) inside
 * the callback therefore trips the guard on the next request — as in Chrome.
 *
 * @param {import('../../storage/indexeddb.js').DbHandle} db
 */
export function withTransactionLifetime(db) {
    const inactiveError = (op) => {
        const error = new Error(
            `TransactionInactiveError: ${op} issued after the transaction auto-committed`
        );
        error.name = 'TransactionInactiveError';
        return error;
    };

    const guardObject = (target, label, isActive) =>
        Object.fromEntries(
            Object.entries(target).map(([key, value]) => {
                if (typeof value !== 'function') {
                    return [key, value];
                }
                if (key === 'index') {
                    return [
                        key,
                        (name) => {
                            if (!isActive()) {
                                throw inactiveError(`${label}.index(${name})`);
                            }
                            return guardObject(value(name), `${label}.index(${name})`, isActive);
                        },
                    ];
                }
                return [
                    key,
                    (...args) => {
                        if (!isActive()) {
                            return Promise.reject(inactiveError(`${label}.${key}`));
                        }
                        return value(...args);
                    },
                ];
            })
        );

    const wrap = (mode) => (storeNames, fn) =>
        db[mode](storeNames, async (scope) => {
            let active = true;
            const timer = setTimeout(() => {
                active = false;
            }, 0);
            const isActive = () => active;
            const guarded = Object.fromEntries(
                Object.entries(scope).map(([name, handle]) => [
                    name,
                    guardObject(handle, name, isActive),
                ])
            );
            try {
                return await fn(guarded);
            } finally {
                clearTimeout(timer);
            }
        });

    return { read: wrap('read'), write: wrap('write') };
}
