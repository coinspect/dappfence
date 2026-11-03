/**
 * App Store Facade.
 *
 * HISTORICAL_SCHEMAS is the single source of truth: the highest key is the
 * current VERSION, its entry is the current SCHEMA. To bump VERSION, append
 * one entry. If the change is structural on an existing store (primaryKeyPath
 * or autoIncrement), rename its `objectStore`. The schema-evolution tests in
 * __tests__/storage-index.test.js enforce the rest.
 */
import { createDatabase } from './indexeddb.js';
import { createManifestStore } from './manifest-store.js';
import { createSecurityStore } from './security-store.js';
import { createSettingsStore } from './settings-store.js';
import { createVerificationResultsStore } from './verification-results-store.js';

export const NAME = 'AppSecurity';
export const VERSION = 2;

/**
 * @satisfies {import('./indexeddb.js').Schema}
 */
export const SCHEMA = {
    manifests: {},
    activeBlocks: {},
    settings: {},
    verificationResults: {},
};

/**
 * Tree-shaken from the prod bundle; used by tests to enforce the versioning
 * convention. Each entry is an explicit copy, not an alias, so edits to
 * SCHEMA that aren't matched by a bump and new HISTORICAL entry fail the
 * lockstep test.
 */
export const HISTORICAL_SCHEMAS = {
    0: {},
    1: { data: {} },
    2: {
        manifests: {},
        activeBlocks: {},
        settings: {},
        verificationResults: {},
    },
};

/**
 * @param {ReturnType<typeof createDatabase>} db
 */
export function createAppStoreFromDb(db) {
    return {
        trustedManifestStore: createManifestStore(db),
        securityStore: createSecurityStore(db),
        settingsStore: createSettingsStore(db),
        verificationResultsStore: createVerificationResultsStore(db),
    };
}

/**
 * @param {IDBFactory} idb
 */
export function createAppStore(idb) {
    const db = createDatabase(idb, { name: NAME, version: VERSION, schema: SCHEMA });
    return createAppStoreFromDb(db);
}
