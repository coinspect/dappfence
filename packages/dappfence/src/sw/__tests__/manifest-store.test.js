import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

describe('createManifestStore', () => {
    let storage;

    beforeEach(() => {
        storage = createManifestStore(createInMemoryDb());
    });

    describe('trustedManifest', () => {
        it('returns undefined for unknown version', async () => {
            const manifest = await storage.get('unknown');
            expect(manifest).toBeUndefined();
        });

        it('returns undefined from getLatest when nothing is stored', async () => {
            const latest = await storage.getLatest();
            expect(latest).toBeUndefined();
        });

        it('addLatest synthesizes a deterministic appVersion from manifest content', async () => {
            const { appVersion } = await storage.addLatest({
                files: { '/a.js': 'h' },
            });
            expect(appVersion).toMatch(/^manifest-[A-Za-z0-9+/]{16}$/);
            const dup = await storage.addLatest({
                files: { '/a.js': 'h' },
            });
            expect(dup.appVersion).toBe(appVersion);
            const other = await storage.addLatest({
                files: { '/b.js': 'h2' },
            });
            expect(other.appVersion).not.toBe(appVersion);
        });

        it('addLatest stores a manifest retrievable by appVersion and via getLatest', async () => {
            const manifestData = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            const { appVersion } = await storage.addLatest(manifestData);

            expect(await storage.get(appVersion)).toEqual(manifestData);
            expect(await storage.getLatest()).toEqual(
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
            const { appVersion } = await storage.addLatest(manifestData);

            expect(await storage.get(appVersion)).toEqual(manifestData);
            expect((await storage.getLatest()).manifest).toEqual(manifestData);
        });

        it('getLatest returns the most recently added manifest', async () => {
            await storage.addLatest({ files: { '/a.js': 'x' } });
            const second = await storage.addLatest({
                files: { '/b.js': 'y' },
            });

            const latest = await storage.getLatest();
            expect(latest.appVersion).toBe(second.appVersion);
            expect(latest.manifest).toEqual({ files: { '/b.js': 'y' } });
        });

        it('addLatest caps entries at 20 (safety bound)', async () => {
            const versions = [];
            for (let i = 1; i <= 25; i++) {
                const { appVersion } = await storage.addLatest({
                    files: { [`/f${i}.js`]: `h${i}` },
                });
                versions.push(appVersion);
            }
            const all = await storage.getAll();
            expect(all).toHaveLength(20);
            expect((await storage.getLatest()).appVersion).toBe(versions[24]);
            // The five earliest additions should have been dropped by the cap.
            for (let i = 0; i < 5; i++) {
                expect(await storage.get(versions[i])).toBeUndefined();
            }
        });

        it('re-adding an existing manifest dedups and promotes it to the front', async () => {
            const a = await storage.addLatest({ files: { '/a.js': 'x' } });
            await storage.addLatest({ files: { '/b.js': 'y' } });
            const aAgain = await storage.addLatest({
                files: { '/a.js': 'x' },
            });

            expect(aAgain.appVersion).toBe(a.appVersion);
            expect((await storage.getLatest()).appVersion).toBe(a.appVersion);
        });

        describe('age-based pruning', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            it('prunes entries older than 24h on next addLatest', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const stale = await storage.addLatest({
                    files: { '/old.js': 'gone' },
                });
                expect(await storage.get(stale.appVersion)).toBeDefined();

                vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
                const fresh = await storage.addLatest({
                    files: { '/new.js': 'kept' },
                });

                expect(await storage.get(stale.appVersion)).toBeUndefined();
                expect(await storage.get(fresh.appVersion)).toBeDefined();
            });

            it('does not prune entries younger than 24h', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                const first = await storage.addLatest({
                    files: { '/a.js': 'ha' },
                });
                vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
                await storage.addLatest({ files: { '/b.js': 'hb' } });

                expect(await storage.get(first.appVersion)).toBeDefined();
            });
        });

        it('getAll returns entries newest-first', async () => {
            const a = await storage.addLatest({ files: { '/a.js': 'ha' } });
            const b = await storage.addLatest({ files: { '/b.js': 'hb' } });
            const c = await storage.addLatest({ files: { '/c.js': 'hc' } });

            const all = await storage.getAll();
            expect(all.map((e) => e.appVersion)).toEqual([
                c.appVersion,
                b.appVersion,
                a.appVersion,
            ]);
        });

        it('getAll returns an empty array when nothing is stored', async () => {
            expect(await storage.getAll()).toEqual([]);
        });
    });
});
