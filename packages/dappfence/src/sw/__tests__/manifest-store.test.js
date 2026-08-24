import { describe, it, expect, vi, beforeEach } from 'vitest';
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
            const normalized = {
                files: { '/app.js': ['abc123'], '/style.css': ['def456'] },
                pathRules: [],
                contentRules: [],
                mode: 'reporting',
            };
            const { appVersion } = await storage.trustedManifestStore.addLatest(manifestData);

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(normalized);
            expect(await storage.trustedManifestStore.getLatest()).toEqual(
                expect.objectContaining({ appVersion, manifest: normalized })
            );
        });

        it('preserves mode, metadata, and other top-level manifest fields', async () => {
            const manifestData = {
                files: { '/app.js': 'abc' },
                mode: 'reporting',
                metadata: { extensions: ['.js', '.wasm'] },
                customField: { future: true },
            };
            const normalized = {
                ...manifestData,
                files: { '/app.js': ['abc'] },
                pathRules: [],
                contentRules: [],
            };
            const { appVersion } = await storage.trustedManifestStore.addLatest(manifestData);

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(normalized);
            expect((await storage.trustedManifestStore.getLatest()).manifest).toEqual(normalized);
        });

        it('getLatest returns the most recently added manifest', async () => {
            await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'x' } });
            const second = await storage.trustedManifestStore.addLatest({
                files: { '/b.js': 'y' },
            });

            const latest = await storage.trustedManifestStore.getLatest();
            expect(latest.appVersion).toBe(second.appVersion);
            expect(latest.manifest).toEqual({
                files: { '/b.js': ['y'] },
                pathRules: [],
                contentRules: [],
                mode: 'reporting',
            });
        });

        it('prunes entries older than 24h on addLatest', async () => {
            vi.useFakeTimers();
            const old = await storage.trustedManifestStore.addLatest({
                files: { '/old.js': 'h-old' },
            });
            vi.advanceTimersByTime(25 * 60 * 60 * 1000);
            await storage.trustedManifestStore.addLatest({ files: { '/new.js': 'h-new' } });
            expect(await storage.trustedManifestStore.get(old.appVersion)).toBeUndefined();
            vi.useRealTimers();
        });

        it('caps at MAX_MANIFESTS entries when many are added rapidly', async () => {
            for (let i = 1; i <= 25; i++) {
                await storage.trustedManifestStore.addLatest({ files: { [`/f${i}.js`]: `h${i}` } });
            }
            const all = await storage.trustedManifestStore.getAll();
            expect(all.length).toBeLessThanOrEqual(20);
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

        it('getAll returns all entries newest-first with storedAt', async () => {
            const a = await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'ha' } });
            const b = await storage.trustedManifestStore.addLatest({ files: { '/b.js': 'hb' } });
            const all = await storage.trustedManifestStore.getAll();
            expect(all).toHaveLength(2);
            expect(all[0].appVersion).toBe(b.appVersion);
            expect(all[1].appVersion).toBe(a.appVersion);
            expect(all[0]).toHaveProperty('storedAt');
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
