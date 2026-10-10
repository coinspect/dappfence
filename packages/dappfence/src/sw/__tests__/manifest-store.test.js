import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';

const MOCK_SIGNER = { signatureType: 'ethereum-personal-sign', identity: '0xmocksigner' };

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
            const { appVersion } = await storage.trustedManifestStore.addLatest(
                { files: { '/a.js': 'h' } },
                MOCK_SIGNER
            );
            expect(appVersion).toMatch(/^manifest-[A-Za-z0-9+/]{16}$/);
            const dup = await storage.trustedManifestStore.addLatest(
                { files: { '/a.js': 'h' } },
                MOCK_SIGNER
            );
            expect(dup.appVersion).toBe(appVersion);
            const other = await storage.trustedManifestStore.addLatest(
                { files: { '/b.js': 'h2' } },
                MOCK_SIGNER
            );
            expect(other.appVersion).not.toBe(appVersion);
        });

        it('addLatest stores a manifest retrievable by appVersion and via getLatest', async () => {
            const manifestData = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            const { appVersion } = await storage.trustedManifestStore.addLatest(
                manifestData,
                MOCK_SIGNER
            );

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
            const { appVersion } = await storage.trustedManifestStore.addLatest(
                manifestData,
                MOCK_SIGNER
            );

            expect(await storage.trustedManifestStore.get(appVersion)).toEqual(manifestData);
            expect((await storage.trustedManifestStore.getLatest()).manifest).toEqual(manifestData);
        });

        it('getLatest returns the most recently added manifest', async () => {
            await storage.trustedManifestStore.addLatest({ files: { '/a.js': 'x' } }, MOCK_SIGNER);
            const second = await storage.trustedManifestStore.addLatest(
                { files: { '/b.js': 'y' } },
                MOCK_SIGNER
            );

            const latest = await storage.trustedManifestStore.getLatest();
            expect(latest.appVersion).toBe(second.appVersion);
            expect(latest.manifest).toEqual({ files: { '/b.js': 'y' } });
        });

        describe('revokeManifests flag', () => {
            it('replaces the entire list with just the new entry when flag is true', async () => {
                await storage.trustedManifestStore.addLatest(
                    { files: { '/old1.js': 'a' } },
                    MOCK_SIGNER
                );
                await storage.trustedManifestStore.addLatest(
                    { files: { '/old2.js': 'b' } },
                    MOCK_SIGNER
                );
                expect(await storage.trustedManifestStore.getAll()).toHaveLength(2);

                const { appVersion } = await storage.trustedManifestStore.addLatest(
                    { files: { '/new.js': 'c' }, revokeManifests: true },
                    MOCK_SIGNER
                );
                const all = await storage.trustedManifestStore.getAll();
                expect(all).toHaveLength(1);
                expect(all[0].appVersion).toBe(appVersion);
                expect(all[0].manifest).toEqual({
                    files: { '/new.js': 'c' },
                    revokeManifests: true,
                });
            });

            it('still prepends normally when flag is absent or falsy', async () => {
                await storage.trustedManifestStore.addLatest(
                    { files: { '/old.js': 'a' } },
                    MOCK_SIGNER
                );
                await storage.trustedManifestStore.addLatest(
                    { files: { '/new.js': 'b' }, revokeManifests: false },
                    MOCK_SIGNER
                );
                expect(await storage.trustedManifestStore.getAll()).toHaveLength(2);
            });

            it('updates the in-memory cache after a revoke', async () => {
                await storage.trustedManifestStore.addLatest(
                    { files: { '/old.js': 'a' } },
                    MOCK_SIGNER
                );
                await storage.trustedManifestStore.addLatest(
                    { files: { '/new.js': 'b' }, revokeManifests: true },
                    MOCK_SIGNER
                );
                const latest = await storage.trustedManifestStore.getLatest();
                expect(latest.manifest.files).toEqual({ '/new.js': 'b' });
            });
        });

        it('addLatest caps entries at 20 (safety bound)', async () => {
            const versions = [];
            for (let i = 1; i <= 25; i++) {
                const { appVersion } = await storage.trustedManifestStore.addLatest(
                    { files: { [`/f${i}.js`]: `h${i}` } },
                    MOCK_SIGNER
                );
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
            const a = await storage.trustedManifestStore.addLatest(
                { files: { '/a.js': 'x' } },
                MOCK_SIGNER
            );
            await storage.trustedManifestStore.addLatest({ files: { '/b.js': 'y' } }, MOCK_SIGNER);
            const aAgain = await storage.trustedManifestStore.addLatest(
                { files: { '/a.js': 'x' } },
                MOCK_SIGNER
            );

            expect(aAgain.appVersion).toBe(a.appVersion);
            expect((await storage.trustedManifestStore.getLatest()).appVersion).toBe(a.appVersion);
        });

        describe('age-based pruning', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            it('prunes entries older than 24h on next addLatest', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const stale = await storage.trustedManifestStore.addLatest(
                    { files: { '/old.js': 'gone' } },
                    MOCK_SIGNER
                );
                expect(await storage.trustedManifestStore.get(stale.appVersion)).toBeDefined();

                vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
                const fresh = await storage.trustedManifestStore.addLatest(
                    { files: { '/new.js': 'kept' } },
                    MOCK_SIGNER
                );

                expect(await storage.trustedManifestStore.get(stale.appVersion)).toBeUndefined();
                expect(await storage.trustedManifestStore.get(fresh.appVersion)).toBeDefined();
            });

            it('does not prune entries younger than 24h', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const first = await storage.trustedManifestStore.addLatest(
                    { files: { '/a.js': 'ha' } },
                    MOCK_SIGNER
                );
                vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
                await storage.trustedManifestStore.addLatest(
                    { files: { '/b.js': 'hb' } },
                    MOCK_SIGNER
                );

                expect(await storage.trustedManifestStore.get(first.appVersion)).toBeDefined();
            });
        });

        it('getAll returns entries newest-first', async () => {
            const a = await storage.trustedManifestStore.addLatest(
                { files: { '/a.js': 'ha' } },
                MOCK_SIGNER
            );
            const b = await storage.trustedManifestStore.addLatest(
                { files: { '/b.js': 'hb' } },
                MOCK_SIGNER
            );
            const c = await storage.trustedManifestStore.addLatest(
                { files: { '/c.js': 'hc' } },
                MOCK_SIGNER
            );

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

        describe('updateActiveIdentity', () => {
            it('writes the supplied identity to the active-identity key', async () => {
                await storage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xnewsigner',
                });
                const anchor = await storage.activeIdentityStore.getActiveIdentity();
                expect(anchor.signatureType).toBe('ethereum-personal-sign');
                expect(anchor.identity).toBe('0xnewsigner');
                expect(typeof anchor.enrolledAt).toBe('number');
            });

            it('overwrites a prior anchor set by addLatest', async () => {
                await storage.trustedManifestStore.addLatest(
                    { files: { '/a.js': 'x' } },
                    { signatureType: 'ethereum-personal-sign', identity: '0xoldsigner' }
                );
                await storage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xnewsigner',
                });
                const anchor = await storage.activeIdentityStore.getActiveIdentity();
                expect(anchor.identity).toBe('0xnewsigner');
            });

            it('keeps the in-memory cache in sync so getActiveIdentity does not re-read IDB', async () => {
                // Prime the cache with the first identity.
                await storage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xfirst',
                });
                await storage.activeIdentityStore.getActiveIdentity();

                // Wrap the underlying get to detect post-update IDB reads.
                const backend = createInMemoryStorage();
                const freshStorage = createManifestStore(backend);
                await freshStorage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xcached',
                });
                const spy = vi.spyOn(backend, 'get');
                const anchor = await freshStorage.activeIdentityStore.getActiveIdentity();
                expect(anchor.identity).toBe('0xcached');
                expect(spy).not.toHaveBeenCalled();
            });

            it('is idempotent — rewriting the same identity leaves the anchor identical in shape', async () => {
                const first = await storage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xsame',
                });
                const second = await storage.activeIdentityStore.updateActiveIdentity({
                    signatureType: 'ethereum-personal-sign',
                    identity: '0xsame',
                });
                expect(second.signatureType).toBe(first.signatureType);
                expect(second.identity).toBe(first.identity);
                // enrolledAt is refreshed each call — that's expected, not a bug.
                expect(typeof second.enrolledAt).toBe('number');
            });
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
