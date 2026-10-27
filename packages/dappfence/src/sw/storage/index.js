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
// Bump whenever SCHEMA changes shape. Version 1 was a single 'data' object
// store holding every key; version 2 is the per-store layout below. The
// database name is unchanged, so without this bump a browser that already
// holds version 1 opens it, skips onupgradeneeded, and every transaction
// naming a store below fails with NotFoundError.
const VERSION = 2;

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
