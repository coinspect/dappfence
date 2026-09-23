import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
            expect(appVersion).toMatch(/^manifest-[A-Za-z0-9+/]{16}$/);
            const dup = await storage.trustedManifestStore.addLatest({
                files: { '/a.js': 'h' },
            });
            expect(dup.appVersion).toBe(appVersion);
            const other = await storage.trustedManifestStore.addLatest({
                files: { '/b.js': 'h2' },
            });
            expect(other.appVersion).not.toBe(appVersion);
        });

        it('addLatest stores a manifest retrievable by appVersion and via getLatest', async () => {
            const manifestData = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            const { appVersion } = await storage.trustedManifestStore.addLatest(manifestData);

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(manifestData);
            expect(await storage.trustedManifestStore.getLatest()).toEqual(
                expect.objectContaining({
                    appVersion,
                    manifest: manifestData,
                })
            );
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

        it('addLatest caps entries at 20 (safety bound)', async () => {
            const versions = [];
            for (let i = 1; i <= 25; i++) {
                const { appVersion } = await storage.trustedManifestStore.addLatest({
                    files: { [`/f${i}.js`]: `h${i}` },
                });
                versions.push(appVersion);
            }
            const all = await storage.trustedManifestStore.getAll();
            expect(all).toHaveLength(20);
            expect((await storage.trustedManifestStore.getLatest()).appVersion).toBe(versions[24]);
            // The five earliest additions should have been dropped by the cap.
            for (let i = 0; i < 5; i++) {
                expect(await storage.trustedManifestStore.get(versions[i])).toBeUndefined();
            }
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

        describe('age-based pruning', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            it('prunes entries older than 24h on next addLatest', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const stale = await storage.trustedManifestStore.addLatest({
                    files: { '/old.js': 'gone' },
                });
                expect(await storage.trustedManifestStore.get(stale.appVersion)).toBeDefined();

                vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
                const fresh = await storage.trustedManifestStore.addLatest({
                    files: { '/new.js': 'kept' },
                });

                expect(await storage.trustedManifestStore.get(stale.appVersion)).toBeUndefined();
                expect(await storage.trustedManifestStore.get(fresh.appVersion)).toBeDefined();
            });

            it('does not prune entries younger than 24h', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const first = await storage.trustedManifestStore.addLatest({
                    files: { '/a.js': 'ha' },
                });
                vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
                await storage.trustedManifestStore.addLatest({ files: { '/b.js': 'hb' } });

                expect(await storage.trustedManifestStore.get(first.appVersion)).toBeDefined();
            });
        });

        it('getAll returns entries newest-first', async () => {
            const a = await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'ha' } });
            const b = await storage.trustedManifestStore.addLatest({ files: { '/b.js': 'hb' } });
            const c = await storage.trustedManifestStore.addLatest({ files: { '/c.js': 'hc' } });

            const all = await storage.trustedManifestStore.getAll();
            expect(all.map((e) => e.appVersion)).toEqual([
                c.appVersion,
                b.appVersion,
                a.appVersion,
            ]);
        });

        it('getAll returns an empty array when nothing is stored', async () => {
            expect(await storage.trustedManifestStore.getAll()).toEqual([]);
        });
    });

    describe('verificationResults', () => {
        it('returns empty array for unknown version', async () => {
            const results = await storage.verificationResultsStore.get('unknown');
            expect(results).toEqual([]);
        });

        it('adds and retrieves verification results (allowlisted fields only)', async () => {
            const result = {
                status: 'MATCH',
                timestamp: '2026-01-01T00:00:00Z',
                fileKey: '/app.js',
                url: 'https://example.com/app.js',
                assetType: 'asset',
                expectedHashes: ['sha256-x'],
                actualHash: 'sha256-x',
            };
            await storage.verificationResultsStore.add('v1', result);

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toEqual([result]);
        });

        it('drops non-cloneable extra fields (defense against Headers/nonce)', async () => {
            await storage.verificationResultsStore.add('v1', {
                status: 'MATCH',
                fileKey: '/a.js',
                headers: new Headers({ 'content-security-policy': "default-src 'none'" }),
                nonce: 'abc',
            });
            const [stored] = await storage.verificationResultsStore.get('v1');
            expect(stored.headers).toBeUndefined();
            expect(stored.nonce).toBeUndefined();
            expect(stored.status).toBe('MATCH');
            expect(stored.fileKey).toBe('/a.js');
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
                await storage.verificationResultsStore.add('v1', {
                    status: 'MATCH',
                    fileKey: `/f${i}.js`,
                });
            }

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toHaveLength(100);
            expect(results[0].fileKey).toBe('/f10.js');
            expect(results[99].fileKey).toBe('/f109.js');
        });
    });
});
