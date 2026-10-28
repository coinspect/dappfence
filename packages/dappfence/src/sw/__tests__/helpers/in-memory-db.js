const SCHEMA_DEFAULT = {
    manifests: {},
    activeBlocks: {},
    settings: {},
    verificationResults: {
        keyPath: 'id',
    },
    telemetryBatches: {
        keyPath: 'id',
    },
};

function compareKeys(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (i >= a.length) {
                return -1;
            }
            if (i >= b.length) {
                return 1;
            }
            const c = compareKeys(a[i], b[i]);
            if (c !== 0) {
                return c;
            }
        }
        return 0;
    }
    if (Array.isArray(a)) {
        return 1;
    }
    if (Array.isArray(b)) {
        return -1;
    }
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}

function inRange(key, range) {
    if (!range) {
        return true;
    }
    if (range.lower !== undefined) {
        const c = compareKeys(key, range.lower);
        if (c < 0 || (c === 0 && range.lowerOpen)) {
            return false;
        }
    }
    if (range.upper !== undefined) {
        const c = compareKeys(key, range.upper);
        if (c > 0 || (c === 0 && range.upperOpen)) {
            return false;
        }
    }
    return true;
}

function indexKeyFn(keyPath) {
    if (Array.isArray(keyPath)) {
        return (row) => keyPath.map((p) => row[p]);
    }
    return (row) => row[keyPath];
}

export function createInMemoryDb(hooks = {}, schema = SCHEMA_DEFAULT) {
    const stores = Object.fromEntries(Object.keys(schema).map((name) => [name, new Map()]));

    const makeHandle = (name) => {
        const data = stores[name];
        const config = schema[name] || {};
        const keyPath = config.keyPath;
        const indexes = Object.fromEntries(
            (config.indexes || []).map((idx) => [idx.name, indexKeyFn(idx.keyPath)])
        );

        const resolveKey = (value, explicitKey) => {
            if (explicitKey !== undefined) {
                return explicitKey;
            }
            if (keyPath) {
                return value[keyPath];
            }
            return undefined;
        };

        const makeIndex = (indexName) => {
            const keyFn = indexes[indexName];
            if (!keyFn) {
                throw new Error(`Index not declared: ${name}.${indexName}`);
            }
            return {
                getAll: async (options = {}) => {
                    let rows = Array.from(data.values());
                    if (options.query !== undefined && options.query !== null) {
                        rows = rows.filter((row) => inRange(keyFn(row), options.query));
                    }
                    rows.sort((a, b) => compareKeys(keyFn(a), keyFn(b)));
                    if (options.direction === 'prev' || options.direction === 'prevunique') {
                        rows.reverse();
                    }
                    if (options.count !== undefined) {
                        rows = rows.slice(0, options.count);
                    }
                    return rows;
                },
                count: async () => data.size,
                openCursor: () => {
                    throw new Error('openCursor not supported in in-memory mock');
                },
            };
        };

        return {
            get: async (key) => {
                hooks.onGet?.(name, key);
                return data.get(key);
            },
            put: async (value, key) => {
                hooks.onPut?.(name, value, key);
                const k = resolveKey(value, key);
                if (k === undefined) {
                    throw new Error(`${name}.put: no key resolvable`);
                }
                data.set(k, value);
            },
            add: async (value, key) => {
                const k = resolveKey(value, key);
                if (k === undefined) {
                    throw new Error(`${name}.add: no key resolvable`);
                }
                if (data.has(k)) {
                    throw new Error('ConstraintError');
                }
                data.set(k, value);
            },
            delete: async (key) => {
                data.delete(key);
            },
            getAll: async () => Array.from(data.values()),
            count: async () => data.size,
            index: makeIndex,
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
