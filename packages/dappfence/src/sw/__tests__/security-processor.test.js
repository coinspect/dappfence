import { describe, it, expect } from 'vitest';
import { createAppStore } from '../storage/index.js';
import { createSecurityProcessor } from '../security-processor.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

function createInMemoryDatabase() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        delete: async (key) => store.delete(key),
        withTx: async (fn) => {
            const result = await fn({
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
            });
            return result;
        },
    };
}

function createSwContext({ userAgent = 'test-ua', origin = 'https://example.com' } = {}) {
    return {
        getUserAgent: () => userAgent,
        getLocationOrigin: () => origin,
    };
}

function createProcessor({ db = createInMemoryDatabase(), swContext = createSwContext() } = {}) {
    const appStore = createAppStore(db);
    const securityProcessor = createSecurityProcessor({ swContext, appStore });
    return { appStore, securityProcessor };
}

describe('createSecurityProcessor', () => {
    it('exposes processSecurityEvent', () => {
        const { securityProcessor } = createProcessor();
        expect(typeof securityProcessor.processSecurityEvent).toBe('function');
    });

    it('exposes reportOnFetch, reportOnInstall, reportOnClientRequest, reportOnPageLoad, reportOnSync', () => {
        const { securityProcessor } = createProcessor();
        expect(typeof securityProcessor.reportOnFetch).toBe('function');
        expect(typeof securityProcessor.reportOnInstall).toBe('function');
        expect(typeof securityProcessor.reportOnClientRequest).toBe('function');
        expect(typeof securityProcessor.reportOnPageLoad).toBe('function');
        expect(typeof securityProcessor.reportOnSync).toBe('function');
    });

    it('reportOnInstall resolves without throwing (stub body)', async () => {
        const { securityProcessor } = createProcessor();
        await expect(securityProcessor.reportOnInstall()).resolves.toBeUndefined();
    });

    it('reportOnSync resolves without throwing (stub body)', async () => {
        const { securityProcessor } = createProcessor();
        await expect(securityProcessor.reportOnSync()).resolves.toBeUndefined();
    });

    it('reportOnFetch extracts clientId from navigation events', async () => {
        const { securityProcessor } = createProcessor();
        const event = {
            request: { mode: 'navigate' },
            clientId: '',
            resultingClientId: 'c-new',
        };
        await expect(securityProcessor.reportOnFetch(event)).resolves.toBeUndefined();
    });

    it('reportOnFetch extracts clientId from non-navigation events', async () => {
        const { securityProcessor } = createProcessor();
        const event = {
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        };
        await expect(securityProcessor.reportOnFetch(event)).resolves.toBeUndefined();
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

    it('stores the security event', async () => {
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ userAgent: 'test-ua', origin: 'https://example.com' }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events.length).toBe(1);
        expect(events[0].status).toBe('FILE_UNTRUSTED');
        expect(events[0].reason).toBe('HASH_MISMATCH');
        expect(events[0].userAgent).toBe('test-ua');
        expect(events[0].origin).toBe('https://example.com');
    });

    it('logs every violation event (including recurrences)', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.processSecurityEvent(mismatchDetails);

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events.length).toBe(2);
    });

    it('stores an active block', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await securityProcessor.processSecurityEvent(mismatchDetails);

        const blocks = await appStore.activeBlocksStore.getActiveBlocks();
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

    it('does not crash if event logging fails', async () => {
        const db = createInMemoryDatabase();
        const originalSet = db.set;
        db.set = async (key, value) => {
            if (key === 'security-events') {
                throw new Error('storage full');
            }
            return originalSet(key, value);
        };
        const { securityProcessor } = createProcessor({ db });
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        expect(mustBlock).toBe(true);
    });

    it('fail-safes to mustBlock=true when outer recordSecurityBlock call throws', async () => {
        const db = {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
            withTx: async () => {
                throw new Error('simulated DB failure');
            },
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

    it('handles securityEventsStore.logSecurityEvent throwing directly', async () => {
        const { securityProcessor, appStore } = createProcessor();
        appStore.securityEventsStore.logSecurityEvent = async () => {
            throw new Error('direct logSecurityEvent failure');
        };
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        expect(mustBlock).toBe(true);
    });

    describe('expectedHashes array contract (shape from verifier)', () => {
        it('persists expectedHashes in the security event', async () => {
            const { securityProcessor, appStore } = createProcessor();
            await securityProcessor.processSecurityEvent(mismatchDetails);
            const events = await appStore.securityEventsStore.getSecurityEvents();
            expect(events[0].expectedHashes).toEqual(['aaaa1111bbbb2222']);
        });

        it('persists expectedHashes in the active block record', async () => {
            const { securityProcessor, appStore } = createProcessor();
            await securityProcessor.processSecurityEvent(mismatchDetails);
            const blocks = await appStore.activeBlocksStore.getActiveBlocks();
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
            const blocks = await appStore.activeBlocksStore.getActiveBlocks();
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
            const blocks = await appStore.activeBlocksStore.getActiveBlocks();
            expect(blocks).toHaveLength(2);
        });
    });
});
