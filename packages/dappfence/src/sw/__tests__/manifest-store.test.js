import { describe, it, expect, beforeEach } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';

function createInMemoryStorage() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        delete: async (key) => store.delete(key),
        withTx: async (fn) =>
            fn({
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
            }),
    };
}

describe('createManifestStore', () => {
    let storage;

    beforeEach(() => {
        storage = createManifestStore(createInMemoryStorage());
    });

    describe('trustedManifest', () => {
        // appVersion is a deterministic synthetic key derived from the
        // manifest content via SHA-256, so tests use distinct content to
        // get distinct keys and capture the returned appVersion when they
        // need to refer to a specific entry.

        it('returns undefined for unknown version', async () => {
            const manifest = await storage.trustedManifestStore.get('unknown');
            expect(manifest).toBeUndefined();
        });

        it('returns undefined from getLatest when nothing is stored', async () => {
            const latest = await storage.trustedManifestStore.getLatest();
            expect(latest).toBeUndefined();
        });

        it('addLatest synthesizes a deterministic appVersion from manifest content', async () => {
            const { appVersion } = await storage.trustedManifestStore.addLatest({
                files: { '/a.js': 'h' },
            });
            // Synthetic appVersion is "manifest-" + 16 chars of base64 entropy
            // (the `sha256-` prefix is stripped before truncation).
            expect(appVersion).toMatch(/^manifest-[A-Za-z0-9+/]{16}$/);
            // Adding the same content again yields the same key.
            const dup = await storage.trustedManifestStore.addLatest({
                files: { '/a.js': 'h' },
            });
            expect(dup.appVersion).toBe(appVersion);
            // Different content yields a different key.
            const other = await storage.trustedManifestStore.addLatest({
                files: { '/b.js': 'h2' },
            });
            expect(other.appVersion).not.toBe(appVersion);
        });

        it('addLatest stores a manifest retrievable by appVersion and via getLatest', async () => {
            const manifestData = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            const { appVersion } = await storage.trustedManifestStore.addLatest(manifestData);

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(manifestData);
            expect(await storage.trustedManifestStore.getLatest()).toEqual({
                appVersion,
                manifest: manifestData,
            });
        });

        it('preserves mode, metadata, and other top-level manifest fields', async () => {
            const manifestData = {
                files: { '/app.js': 'abc' },
                mode: 'reporting',
                metadata: { extensions: ['.js', '.wasm'] },
                customField: { future: true },
            };
            const { appVersion } = await storage.trustedManifestStore.addLatest(manifestData);

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(manifestData);
            expect((await storage.trustedManifestStore.getLatest()).manifest).toEqual(manifestData);
        });

        it('getLatest returns the most recently added manifest', async () => {
            await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'x' } });
            const second = await storage.trustedManifestStore.addLatest({
                files: { '/b.js': 'y' },
            });

            const latest = await storage.trustedManifestStore.getLatest();
            expect(latest.appVersion).toBe(second.appVersion);
            expect(latest.manifest).toEqual({ files: { '/b.js': 'y' } });
        });

        it('addLatest evicts the oldest entry once length exceeds 5', async () => {
            const versions = [];
            for (let i = 1; i <= 6; i++) {
                const { appVersion } = await storage.trustedManifestStore.addLatest({
                    files: { [`/f${i}.js`]: `h${i}` },
                });
                versions.push(appVersion);
            }
            // First addition (oldest) should have been evicted.
            expect(await storage.trustedManifestStore.get(versions[0])).toBeUndefined();
            // Last addition (newest) should be the latest.
            expect((await storage.trustedManifestStore.getLatest()).appVersion).toBe(versions[5]);
            // Second-oldest still present.
            expect(await storage.trustedManifestStore.get(versions[1])).toEqual({
                files: { '/f2.js': 'h2' },
            });
        });

        it('re-adding an existing manifest dedups and promotes it to the front', async () => {
            const a = await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'x' } });
            await storage.trustedManifestStore.addLatest({ files: { '/b.js': 'y' } });
            const aAgain = await storage.trustedManifestStore.addLatest({
                files: { '/a.js': 'x' },
            });

            expect(aAgain.appVersion).toBe(a.appVersion);
            expect((await storage.trustedManifestStore.getLatest()).appVersion).toBe(a.appVersion);
        });

        it('findByHash returns the entry that owns a hash', async () => {
            const a = await storage.trustedManifestStore.addLatest({
                files: { '/a.js': 'hash-a', '/b.js': 'hash-b' },
            });
            const b = await storage.trustedManifestStore.addLatest({
                files: { '/c.js': 'hash-c' },
            });

            expect(await storage.trustedManifestStore.findByHash('hash-a')).toEqual({
                appVersion: a.appVersion,
                manifest: a.manifest,
            });
            expect(await storage.trustedManifestStore.findByHash('hash-c')).toEqual({
                appVersion: b.appVersion,
                manifest: b.manifest,
            });
            expect(await storage.trustedManifestStore.findByHash('missing')).toBeNull();
        });

        it('findByHash prefers the newest manifest when a hash collides', async () => {
            await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'shared' } });
            const newer = await storage.trustedManifestStore.addLatest({
                files: { '/b.js': 'shared' },
            });

            const found = await storage.trustedManifestStore.findByHash('shared');
            expect(found.appVersion).toBe(newer.appVersion);
        });

        it('findByHash drops hashes that were only in evicted manifests', async () => {
            await storage.trustedManifestStore.addLatest({ files: { '/old.js': 'gone' } });
            const survivors = [];
            for (let i = 1; i <= 5; i++) {
                const { appVersion } = await storage.trustedManifestStore.addLatest({
                    files: { [`/f${i}.js`]: `h${i}` },
                });
                survivors.push(appVersion);
            }
            // The oldest entry has been evicted; its hashes should no longer resolve.
            expect(await storage.trustedManifestStore.findByHash('gone')).toBeNull();
            const found = await storage.trustedManifestStore.findByHash('h1');
            expect(found.appVersion).toBe(survivors[0]);
        });

        it('findByHash rebuilds the in-memory index lazily after a fresh store is created', async () => {
            // Populate via one store, then create a new one over the same backend
            // — simulates SW restart where the in-memory index is empty.
            await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'hash-a' } });
            const sameBackend = createInMemoryStorage();
            // Copy persisted state
            const persisted = { appVersion: 'v1', manifest: { files: { '/a.js': 'hash-a' } } };
            await sameBackend.set('trusted-manifest', [persisted]);
            const reopened = createManifestStore(sameBackend);
            expect(await reopened.trustedManifestStore.findByHash('hash-a')).toEqual(persisted);
        });

        it('line 69: findByHash does not throw when manifest.files is undefined', async () => {
            const db = createInMemoryStorage();
            await db.set('trusted-manifest', [
                { appVersion: 'v-no-files', manifest: { mode: 'reporting' } },
            ]);
            const store = createManifestStore(db);
            const found = await store.trustedManifestStore.findByHash('nonexistent-hash');
            expect(found).toBeNull();
        });
    });

    describe('verificationResults', () => {
        it('returns empty array for unknown version', async () => {
            const results = await storage.verificationResultsStore.get('unknown');
            expect(results).toEqual([]);
        });

        it('adds and retrieves verification results', async () => {
            const result = { status: 'MATCH', fileKey: '/app.js' };
            await storage.verificationResultsStore.add('v1', result);

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toEqual([result]);
        });

        it('appends multiple results for same version', async () => {
            await storage.verificationResultsStore.add('v1', {
                status: 'MATCH',
                fileKey: '/a.js',
            });
            await storage.verificationResultsStore.add('v1', {
                status: 'MISMATCH',
                fileKey: '/b.js',
            });

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toHaveLength(2);
            expect(results[0].fileKey).toBe('/a.js');
            expect(results[1].fileKey).toBe('/b.js');
        });

        it('keeps results isolated by version', async () => {
            await storage.verificationResultsStore.add('v1', { fileKey: '/a.js' });
            await storage.verificationResultsStore.add('v2', { fileKey: '/b.js' });

            expect(await storage.verificationResultsStore.get('v1')).toHaveLength(1);
            expect(await storage.verificationResultsStore.get('v2')).toHaveLength(1);
        });

        it('caps results at 100 per version', async () => {
            for (let i = 0; i < 110; i++) {
                await storage.verificationResultsStore.add('v1', { index: i });
            }

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toHaveLength(100);
            // Should keep the last 100 (indices 10-109)
            expect(results[0].index).toBe(10);
            expect(results[99].index).toBe(109);
        });
    });
});
