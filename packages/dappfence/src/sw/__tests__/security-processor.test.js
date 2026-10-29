import { describe, it, expect } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';
import { createSecurityStore } from '../storage/security-store.js';
import { createSettingsStore } from '../storage/settings-store.js';
import { createVerificationResultsStore } from '../storage/verification-results-store.js';
import { createSecurityProcessor } from '../security-processor.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

function createSwContext({ userAgent = 'test-ua', origin = 'https://example.com' } = {}) {
    return {
        getUserAgent: () => userAgent,
        getLocationOrigin: () => origin,
    };
}

function createProcessor({ db = createInMemoryDb(), swContext = createSwContext() } = {}) {
    const appStore = {
        trustedManifestStore: createManifestStore(db),
        securityStore: createSecurityStore(db),
        settingsStore: createSettingsStore(db),
        verificationResultsStore: createVerificationResultsStore(db),
    };
    const securityProcessor = createSecurityProcessor({ swContext, appStore });
    return { appStore, securityProcessor };
}

function createFetchEvent(clientId = 'c1') {
    return { request: { mode: 'no-cors' }, clientId, resultingClientId: '' };
}

async function processAndDrain(securityProcessor, details) {
    const mustBlock = await securityProcessor.processSecurityEvent(details);
    await securityProcessor.reportAfterFetch(createFetchEvent());
    return mustBlock;
}

describe('createSecurityProcessor', () => {
    it('exposes processSecurityEvent', () => {
        const { securityProcessor } = createProcessor();
        expect(typeof securityProcessor.processSecurityEvent).toBe('function');
    });

    it('exposes reportAfterFetch, reportAfterInstall, reportOnClientRequest, reportOnPageLoad, reportOnSync', () => {
        const { securityProcessor } = createProcessor();
        expect(typeof securityProcessor.reportAfterFetch).toBe('function');
        expect(typeof securityProcessor.reportAfterInstall).toBe('function');
        expect(typeof securityProcessor.reportOnClientRequest).toBe('function');
        expect(typeof securityProcessor.reportOnPageLoad).toBe('function');
        expect(typeof securityProcessor.reportOnSync).toBe('function');
    });

    it('reportAfterInstall resolves without throwing (stub body)', async () => {
        const { securityProcessor } = createProcessor();
        await expect(securityProcessor.reportAfterInstall()).resolves.toBeUndefined();
    });

    it('reportOnSync resolves without throwing (stub body)', async () => {
        const { securityProcessor } = createProcessor();
        await expect(securityProcessor.reportOnSync()).resolves.toBeUndefined();
    });

    it('reportAfterFetch extracts clientId from navigation events', async () => {
        const { securityProcessor } = createProcessor();
        const event = {
            request: { mode: 'navigate' },
            clientId: '',
            resultingClientId: 'c-new',
        };
        await expect(securityProcessor.reportAfterFetch(event)).resolves.toBeUndefined();
    });

    it('reportAfterFetch extracts clientId from non-navigation events', async () => {
        const { securityProcessor } = createProcessor();
        const event = {
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        };
        await expect(securityProcessor.reportAfterFetch(event)).resolves.toBeUndefined();
    });
});

describe('processSecurityEvent', () => {
    const mismatchDetails = {
        status: VERIFICATION_STATUS.FILE_UNTRUSTED,
        reason: 'HASH_MISMATCH',
        fileKey: '/app.js',
        url: 'https://example.com/app.js',
        expectedHashes: ['aaaa1111bbbb2222'],
        actualHash: 'cccc3333dddd4444',
        assetType: 'asset',
    };

    it('returns mustBlock=true when a mismatch violation adds a new active block', async () => {
        const { securityProcessor } = createProcessor();
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        expect(mustBlock).toBe(true);
    });

    it('returns mustBlock=false for a recurrence of a known block', async () => {
        const { securityProcessor } = createProcessor();
        await securityProcessor.processSecurityEvent(mismatchDetails);
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        expect(mustBlock).toBe(false);
    });

    it('stores an active block', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await securityProcessor.processSecurityEvent(mismatchDetails);

        const blocks = await appStore.securityStore.getActiveBlocks();
        expect(blocks.length).toBe(1);
        expect(blocks[0].fileKey).toBe('/app.js');
    });

    it('MATCH is a no-op (returns false)', async () => {
        const { securityProcessor } = createProcessor();
        const mustBlock = await securityProcessor.processSecurityEvent({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.MATCH,
        });
        expect(mustBlock).toBe(false);
    });

    it('persists non-SKIPPED non-MATCH events (FILE_UNTRUSTED) via verificationResultsStore', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await processAndDrain(securityProcessor, {
            ...mismatchDetails,
            manifestInfo: { appVersion: 'v1' },
        });
        const results = await appStore.verificationResultsStore.get('v1');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            status: 'FILE_UNTRUSTED',
            reason: 'HASH_MISMATCH',
            fileKey: '/app.js',
        });
        expect(results[0].url).toBeUndefined();
        expect(results[0].assetType).toBeUndefined();
    });

    it('does not persist SKIPPED to any store', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await processAndDrain(securityProcessor, {
            ...mismatchDetails,
            status: VERIFICATION_STATUS.SKIPPED,
            manifestInfo: { appVersion: 'v1' },
        });

        const matches = await appStore.verificationResultsStore.get('v1');
        expect(matches).toEqual([]);
        const blocks = await appStore.securityStore.getAllBlocks();
        expect(blocks).toHaveLength(0);
    });

    it('handles FILE_UNTRUSTED+NOT_IN_MANIFEST violation', async () => {
        const { securityProcessor } = createProcessor();
        const mustBlock = await securityProcessor.processSecurityEvent({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.FILE_UNTRUSTED,
            reason: 'NOT_IN_MANIFEST',
        });
        expect(mustBlock).toBe(true);
    });

    it('handles unknown violation types', async () => {
        const { securityProcessor } = createProcessor();
        const mustBlock = await securityProcessor.processSecurityEvent({
            ...mismatchDetails,
            status: { description: 'UNKNOWN_TYPE', isViolation: true },
        });
        expect(mustBlock).toBe(true);
    });

    it('handles VERIFICATION_STATUS.ERROR without throwing', async () => {
        const { securityProcessor } = createProcessor();
        const mustBlock = await securityProcessor.processSecurityEvent({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.ERROR,
        });
        expect(mustBlock).toBe(true);
    });

    it('fail-safes to mustBlock=true when outer recordSecurityViolation call throws', async () => {
        const db = async () => {
            throw new Error('simulated DB failure');
        };
        const { securityProcessor } = createProcessor({ db });
        const details = {
            status: VERIFICATION_STATUS.FILE_UNTRUSTED,
            reason: 'HASH_MISMATCH',
            fileKey: '/bad.js',
            url: 'https://example.com/bad.js',
            assetType: 'asset',
        };
        const mustBlock = await securityProcessor.processSecurityEvent(details);
        expect(mustBlock).toBe(true);
    });

    describe('expectedHashes array contract (shape from verifier)', () => {
        it('persists expectedHashes in the active block record', async () => {
            const { securityProcessor, appStore } = createProcessor();
            await securityProcessor.processSecurityEvent(mismatchDetails);
            const blocks = await appStore.securityStore.getActiveBlocks();
            expect(blocks[0].expectedHashes).toEqual(['aaaa1111bbbb2222']);
        });

        it('deduplicates correctly when the same multi-hash array is reported twice', async () => {
            const multiHash = {
                ...mismatchDetails,
                expectedHashes: ['hash-a', 'hash-b'],
            };
            const { securityProcessor, appStore } = createProcessor();
            const first = await securityProcessor.processSecurityEvent(multiHash);
            const second = await securityProcessor.processSecurityEvent(multiHash);
            expect(first).toBe(true);
            expect(second).toBe(false);
            const blocks = await appStore.securityStore.getActiveBlocks();
            expect(blocks).toHaveLength(1);
        });

        it('treats different expectedHashes arrays as distinct violations', async () => {
            const { securityProcessor, appStore } = createProcessor();
            await securityProcessor.processSecurityEvent({
                ...mismatchDetails,
                expectedHashes: ['hash-a'],
            });
            await securityProcessor.processSecurityEvent({
                ...mismatchDetails,
                expectedHashes: ['hash-b'],
            });
            const blocks = await appStore.securityStore.getActiveBlocks();
            expect(blocks).toHaveLength(2);
        });
    });
});
