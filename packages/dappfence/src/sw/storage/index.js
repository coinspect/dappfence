/**
 * App Store Facade — a thin bundle of the IndexedDB-backed stores.
 *
 * Manifest Store properties (trustedManifest, verificationResults) are spread at
 * the top level since they're already uniquely named. The others are grouped.
 *
 * Orchestration of security verdicts (updating activeBlocksStore + deciding
 * mustBlock) lives in sw/security-processor.js — this module just exposes the
 * raw stores.
 */
import { createManifestStore } from './manifest-store.js';
import { createActiveBlocksStore, createApiTokenStore } from './security-stores.js';

/**
 * @param {object} db - Low-level Store backend from createDatabase()
 */
export function createAppStore(db) {
    return {
        ...createManifestStore(db),
        activeBlocksStore: createActiveBlocksStore(db),
        apiTokenStore: createApiTokenStore(db),
    };
}
