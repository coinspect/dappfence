/**
 * App Store Facade — a thin bundle of the IndexedDB-backed stores.
 *
 * Orchestration of security verdicts (updating securityStore + deciding
 * mustBlock) lives in sw/security-processor.js — this module just exposes the
 * raw stores.
 */
import { createDatabase } from './indexeddb.js';
import { createManifestStore } from './manifest-store.js';
import { createSecurityStore } from './security-store.js';
import { createSettingsStore } from './settings-store.js';
import { createVerificationResultsStore } from './verification-results-store.js';

const NAME = 'AppSecurity';
const VERSION = 1;

/**
 * @satisfies {import('./indexeddb.js').Schema}
 */
const SCHEMA = {
    manifests: {},
    activeBlocks: {},
    settings: {},
    verificationResults: {},
};

/**
 * @param {import('./indexeddb.js').Database} db
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
    return createAppStoreFromDb(
        createDatabase(idb, { name: NAME, version: VERSION, schema: SCHEMA })
    );
}
