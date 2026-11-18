import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

/**
 * @param {string} appVersion
 * @param {object} manifest
 * @param {object} [signedEnvelope]
 */
const entry = (
    appVersion,
    manifest,
    signedEnvelope = { pay: manifest, sig: `sig-${appVersion}` }
) => ({
    appVersion,
    manifest,
    signedEnvelope,
});

describe('createManifestStore', () => {
    let storage;

    beforeEach(() => {
        storage = createManifestStore(createInMemoryDb());
    });

    describe('trustedManifest', () => {
        it('returns undefined for unknown version', async () => {
            expect(await storage.get('unknown')).toBeUndefined();
        });

        it('returns undefined from getLatest when nothing is stored', async () => {
            expect(await storage.getLatest()).toBeUndefined();
        });

        it('addLatest stores a manifest retrievable by appVersion and via getLatest', async () => {
            const manifest = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            await storage.addLatest(entry('v-1', manifest));

            expect(await storage.get('v-1')).toEqual(manifest);
            expect(await storage.getLatest()).toEqual(
                expect.objectContaining({
                    appVersion: 'v-1',
                    manifest,
                })
            );
        });

        it('preserves mode, metadata, and other top-level manifest fields', async () => {
            const manifest = {
                files: { '/app.js': 'abc' },
                mode: 'reporting',
                metadata: { extensions: ['.js', '.wasm'] },
                customField: { future: true },
            };
            await storage.addLatest(entry('v-1', manifest));

            expect(await storage.get('v-1')).toEqual(manifest);
            expect((await storage.getLatest()).manifest).toEqual(manifest);
        });

        it('getLatest returns the most recently added manifest', async () => {
            await storage.addLatest(entry('v-1', { files: { '/a.js': 'x' } }));
            await storage.addLatest(entry('v-2', { files: { '/b.js': 'y' } }));

            const latest = await storage.getLatest();
            expect(latest.appVersion).toBe('v-2');
            expect(latest.manifest).toEqual({ files: { '/b.js': 'y' } });
        });

        it('addLatest caps entries at 20 (safety bound)', async () => {
            const versions = [];
            for (let i = 1; i <= 25; i++) {
                const v = `v-${i}`;
                await storage.addLatest(entry(v, { files: { [`/f${i}.js`]: `h${i}` } }));
                versions.push(v);
            }

            expect(await storage.getAll()).toHaveLength(20);
            expect((await storage.getLatest()).appVersion).toBe(versions[24]);
            for (let i = 0; i < 5; i++) {
                expect(await storage.get(versions[i])).toBeUndefined();
            }
        });

        it('re-adding an existing appVersion dedups and promotes it to the front', async () => {
            await storage.addLatest(entry('v-a', { files: { '/a.js': 'x' } }));
            await storage.addLatest(entry('v-b', { files: { '/b.js': 'y' } }));
            await storage.addLatest(entry('v-a', { files: { '/a.js': 'x' } }));

            expect((await storage.getLatest()).appVersion).toBe('v-a');
            expect(await storage.getAll()).toHaveLength(2);
        });

        it('getSignedEnvelope returns the stored {pay, sig} envelope', async () => {
            const signedEnvelope = { pay: { files: { '/a.js': 'h' } }, sig: '0xdeadbeef' };
            await storage.addLatest(entry('v-1', { files: { '/a.js': 'h' } }, signedEnvelope));

            expect(await storage.getSignedEnvelope('v-1')).toEqual(signedEnvelope);
            expect(await storage.getSignedEnvelope('unknown')).toBeUndefined();
        });

        describe('age-based pruning', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            it('prunes entries older than 24h on next addLatest', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                await storage.addLatest(entry('v-stale', { files: { '/old.js': 'gone' } }));
                expect(await storage.get('v-stale')).toBeDefined();

                vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
                await storage.addLatest(entry('v-fresh', { files: { '/new.js': 'kept' } }));

                expect(await storage.get('v-stale')).toBeUndefined();
                expect(await storage.get('v-fresh')).toBeDefined();
            });

            it('does not prune entries younger than 24h', async () => {
                vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
                await storage.addLatest(entry('v-first', { files: { '/a.js': 'ha' } }));
                vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
                await storage.addLatest(entry('v-second', { files: { '/b.js': 'hb' } }));

                expect(await storage.get('v-first')).toBeDefined();
            });
        });

        it('getAll returns entries newest-first', async () => {
            await storage.addLatest(entry('v-a', { files: { '/a.js': 'ha' } }));
            await storage.addLatest(entry('v-b', { files: { '/b.js': 'hb' } }));
            await storage.addLatest(entry('v-c', { files: { '/c.js': 'hc' } }));

            const all = await storage.getAll();
            expect(all.map((e) => e.appVersion)).toEqual(['v-c', 'v-b', 'v-a']);
        });

        it('getAll returns an empty array when nothing is stored', async () => {
            expect(await storage.getAll()).toEqual([]);
        });
    });
});
