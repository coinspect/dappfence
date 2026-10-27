import { describe, it, expect, beforeEach } from 'vitest';
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
        const results = await store.get('unknown');
        expect(results).toEqual([]);
    });

    it('adds and retrieves verification results (projection drops dead fields)', async () => {
        await store.add(
            detailsFor('v1', {
                fileKey: '/app.js',
                url: 'https://example.com/app.js',
                assetType: 'asset',
                expectedHashes: ['sha256-x'],
                actualHash: 'sha256-x',
            })
        );
        const [stored] = await store.get('v1');
        expect(stored).toMatchObject({
            status: 'MATCH',
            fileKey: '/app.js',
            expectedHashes: ['sha256-x'],
            actualHash: 'sha256-x',
        });
        expect(stored.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(stored.url).toBeUndefined();
        expect(stored.assetType).toBeUndefined();
        expect(stored.appVersion).toBeUndefined();
    });

    it('persists reason on failed verifications (fixes UI mismatch/unknown badge counts)', async () => {
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

    it('drops non-cloneable extra fields (defense against Headers/nonce)', async () => {
        await store.add(
            detailsFor('v1', {
                fileKey: '/a.js',
                headers: new Headers({ 'content-security-policy': "default-src 'none'" }),
                nonce: 'abc',
            })
        );
        const [stored] = await store.get('v1');
        expect(stored.headers).toBeUndefined();
        expect(stored.nonce).toBeUndefined();
        expect(stored.status).toBe('MATCH');
        expect(stored.fileKey).toBe('/a.js');
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
        await store.add({
            status: VERIFICATION_STATUS.MATCH,
            fileKey: '/no-manifest.js',
        });
        await store.add({
            status: VERIFICATION_STATUS.MATCH,
            fileKey: '/empty-manifest.js',
            manifestInfo: {},
        });
        expect(await store.get('v1')).toEqual([]);
        expect(await store.get('')).toEqual([]);
    });

    it('appends multiple results for same version', async () => {
        await store.add(detailsFor('v1', { fileKey: '/a.js' }));
        await store.add(
            detailsFor('v1', { status: VERIFICATION_STATUS.FILE_UNTRUSTED, fileKey: '/b.js' })
        );
        const results = await store.get('v1');
        expect(results).toHaveLength(2);
        expect(results[0].fileKey).toBe('/a.js');
        expect(results[1].fileKey).toBe('/b.js');
    });

    it('keeps results isolated by version', async () => {
        await store.add(detailsFor('v1', { fileKey: '/a.js' }));
        await store.add(detailsFor('v2', { fileKey: '/b.js' }));
        expect(await store.get('v1')).toHaveLength(1);
        expect(await store.get('v2')).toHaveLength(1);
    });

    it('caps results at 100 per version', async () => {
        for (let i = 0; i < 110; i++) {
            await store.add(detailsFor('v1', { fileKey: `/f${i}.js` }));
        }
        const results = await store.get('v1');
        expect(results).toHaveLength(100);
        expect(results[0].fileKey).toBe('/f10.js');
        expect(results[99].fileKey).toBe('/f109.js');
    });
});
