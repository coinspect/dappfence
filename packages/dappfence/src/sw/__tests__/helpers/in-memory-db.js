export function createInMemoryDb(hooks = {}) {
    const stores = {
        manifests: new Map(),
        activeBlocks: new Map(),
        settings: new Map(),
        verificationResults: new Map(),
    };
    const makeHandle = (name) => {
        const data = stores[name];
        return {
            get: async (key) => {
                hooks.onGet?.(name, key);
                return data.get(key);
            },
            put: async (value, key) => {
                hooks.onPut?.(name, value, key);
                data.set(key, value);
            },
            add: async (value, key) => {
                if (data.has(key)) {
                    throw new Error('ConstraintError');
                }
                data.set(key, value);
            },
            delete: async (key) => {
                data.delete(key);
            },
            getAll: async () => Array.from(data.values()),
            count: async () => data.size,
            index: () => {
                throw new Error('indexes not supported in in-memory mock yet');
            },
        };
    };

    async function runScoped(storeNames, fn) {
        const scope = {};
        for (const name of storeNames) {
            scope[name] = makeHandle(name);
        }
        return fn(scope);
    }

    return {
        read: (storeNames, fn) => runScoped(storeNames, fn),
        write: (storeNames, fn) => runScoped(storeNames, fn),
    };
}
