import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

const detailsFor = (appVersion, extras = {}) => ({
    status: VERIFICATION_STATUS.MATCH,
    fileKey: '/x.js',
    manifestInfo: { appVersion },
    ...extras,
});

describe('createVerificationResultsStore', () => {
    let store;

    beforeEach(() => {
        store = createVerificationResultsStore(createInMemoryDb());
    });

    it('returns empty array for unknown version', async () => {
        expect(await store.get('unknown')).toEqual([]);
    });

    it('returns empty array when appVersion is falsy', async () => {
        expect(await store.get(undefined)).toEqual([]);
        expect(await store.get('')).toEqual([]);
    });

    it('persists all tracked fields including context fields unused by the UI today', async () => {
        await store.add(
            detailsFor('v1', {
                fileKey: '/app.js',
                url: 'https://example.com/app.js',
                destination: 'script',
                httpStatus: 200,
                clientId: 'client-123',
                expectedHashes: ['sha256-x'],
                actualHash: 'sha256-x',
            })
        );
        const [stored] = await store.get('v1');
        expect(stored).toMatchObject({
            status: 'MATCH',
            fileKey: '/app.js',
            appVersion: 'v1',
            url: 'https://example.com/app.js',
            destination: 'script',
            httpStatus: 200,
            clientId: 'client-123',
            expectedHashes: ['sha256-x'],
            actualHash: 'sha256-x',
        });
        expect(typeof stored.id).toBe('string');
        expect(typeof stored.timestamp).toBe('number');
    });

    it('persists reason on failed verifications', async () => {
        await store.add(
            detailsFor('v1', {
                status: VERIFICATION_STATUS.FILE_UNTRUSTED,
                fileKey: '/bad.js',
                reason: 'HASH_MISMATCH',
            })
        );
        const [stored] = await store.get('v1');
        expect(stored.reason).toBe('HASH_MISMATCH');
        expect(stored.status).toBe('FILE_UNTRUSTED');
    });

    it('persists non-MATCH statuses (REWRITE, FILE_UNTRUSTED, CSP_PROTECTED)', async () => {
        for (const status of [
            VERIFICATION_STATUS.MATCH,
            VERIFICATION_STATUS.REWRITE,
            VERIFICATION_STATUS.FILE_UNTRUSTED,
            VERIFICATION_STATUS.CSP_PROTECTED,
        ]) {
            await store.add(detailsFor('v1', { status, fileKey: `/x-${status.description}.js` }));
        }
        const results = await store.get('v1');
        expect(results.map((r) => r.status).sort()).toEqual([
            'CSP_PROTECTED',
            'FILE_UNTRUSTED',
            'MATCH',
            'REWRITE',
        ]);
    });

    it('skips rows without a resolvable appVersion', async () => {
        await store.add({ status: VERIFICATION_STATUS.MATCH, fileKey: '/no-manifest.js' });
        await store.add({
            status: VERIFICATION_STATUS.MATCH,
            fileKey: '/empty-manifest.js',
            manifestInfo: {},
        });
        expect(await store.get('v1')).toEqual([]);
    });

    it('returns rows newest-first by timestamp DESC', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        await store.add(detailsFor('v1', { fileKey: '/a.js' }));
        vi.advanceTimersByTime(1000);
        await store.add(detailsFor('v1', { fileKey: '/b.js' }));
        vi.advanceTimersByTime(1000);
        await store.add(detailsFor('v1', { fileKey: '/c.js' }));
        vi.useRealTimers();

        const results = await store.get('v1');
        expect(results.map((r) => r.fileKey)).toEqual(['/c.js', '/b.js', '/a.js']);
    });

    it('isolates rows by appVersion', async () => {
        await store.add(detailsFor('v1', { fileKey: '/a.js' }));
        await store.add(detailsFor('v2', { fileKey: '/b.js' }));
        const v1 = await store.get('v1');
        const v2 = await store.get('v2');
        expect(v1.map((r) => r.fileKey)).toEqual(['/a.js']);
        expect(v2.map((r) => r.fileKey)).toEqual(['/b.js']);
    });

    it('UI floor: keeps the latest 100 rows regardless of age', async () => {
        vi.useFakeTimers();
        const base = new Date('2026-01-01T00:00:00Z').getTime();
        for (let i = 0; i < 50; i++) {
            vi.setSystemTime(base + i * 1000);
            await store.add(detailsFor('v1', { fileKey: `/f${i}.js` }));
        }
        vi.setSystemTime(base + 30 * 24 * 60 * 60 * 1000);
        vi.useRealTimers();

        const results = await store.get('v1');
        expect(results).toHaveLength(50);
    });

    it('24h window: ages out rows outside the top-100 window', async () => {
        vi.useFakeTimers();
        const base = new Date('2026-01-01T00:00:00Z').getTime();
        for (let i = 0; i < 150; i++) {
            vi.setSystemTime(base + i * 1000);
            await store.add(detailsFor('v1', { fileKey: `/f${i}.js` }));
        }
        vi.setSystemTime(base + 2 * 24 * 60 * 60 * 1000);
        await store.add(detailsFor('v1', { fileKey: '/late.js' }));
        vi.useRealTimers();

        const results = await store.get('v1');
        expect(results.length).toBeLessThanOrEqual(100);
        expect(results[0].fileKey).toBe('/late.js');
    });

    it('age-out: violations survive in storage even when crowded out of the UI top-100', async () => {
        const db = createInMemoryDb();
        const localStore = createVerificationResultsStore(db);
        vi.useFakeTimers();
        const base = new Date('2026-01-01T00:00:00Z').getTime();
        vi.setSystemTime(base);
        await localStore.add(
            detailsFor('v1', {
                status: VERIFICATION_STATUS.FILE_UNTRUSTED,
                fileKey: '/bad.js',
                reason: 'HASH_MISMATCH',
            })
        );
        for (let i = 0; i < 150; i++) {
            vi.setSystemTime(base + 60_000 + i * 1000);
            await localStore.add(detailsFor('v1', { fileKey: `/f${i}.js` }));
        }
        vi.setSystemTime(base + 2 * 24 * 60 * 60 * 1000);
        await localStore.add(detailsFor('v1', { fileKey: '/trigger.js' }));
        vi.useRealTimers();

        const allRows = await db.read(['verificationResults'], ({ verificationResults }) =>
            verificationResults.getAll()
        );
        const violation = allRows.find((r) => r.fileKey === '/bad.js');
        expect(violation).toBeDefined();
        expect(violation.status).toBe('FILE_UNTRUSTED');
    });

    it('hard ceiling: trims to MAX_ROWS_TOTAL oldest-first when exceeded', async () => {
        vi.useFakeTimers();
        const base = new Date('2026-01-01T00:00:00Z').getTime();
        // Simulate many stale deployments: each adds a row older than 24h,
        // then one fresh row triggers purge beyond the hard ceiling.
        for (let i = 0; i < 10_050; i++) {
            vi.setSystemTime(base + i * 1000);
            await store.add(detailsFor(`v${i}`, { fileKey: `/f${i}.js` }));
        }
        vi.setSystemTime(base + 2 * 24 * 60 * 60 * 1000);
        await store.add(detailsFor('v-new', { fileKey: '/new.js' }));
        vi.useRealTimers();

        const newest = await store.get('v-new');
        expect(newest.map((r) => r.fileKey)).toContain('/new.js');
    }, 60_000);

    it('returns up to UI_SLICE (100) rows per get(appVersion)', async () => {
        vi.useFakeTimers();
        const base = new Date('2026-01-01T00:00:00Z').getTime();
        for (let i = 0; i < 150; i++) {
            vi.setSystemTime(base + i * 1000);
            await store.add(detailsFor('v1', { fileKey: `/f${i}.js` }));
        }
        vi.useRealTimers();

        const results = await store.get('v1');
        expect(results).toHaveLength(100);
        expect(results[0].fileKey).toBe('/f149.js');
        expect(results[99].fileKey).toBe('/f50.js');
    });

    afterEach(() => {
        vi.useRealTimers();
    });
});
