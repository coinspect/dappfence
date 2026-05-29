import { describe, it, expect } from 'vitest';
import { createAppStore } from '../storage/index.js';
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

describe('createAppStore', () => {
    it('returns all expected store properties', () => {
        const appStore = createAppStore(createInMemoryDatabase());

        // Manifest store (spread at top level)
        expect(appStore.trustedManifestStore).toBeDefined();
        expect(appStore.verificationResultsStore).toBeDefined();

        // Grouped stores
        expect(appStore.activeBlocksStore).toBeDefined();
        expect(appStore.securityEventsStore).toBeDefined();
        expect(appStore.apiTokenStore).toBeDefined();
    });

    it('manifest stores are functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const { appVersion } = await appStore.trustedManifestStore.addLatest({
            files: { '/a.js': 'h' },
        });
        const latest = await appStore.trustedManifestStore.getLatest();
        expect(latest.appVersion).toBe(appVersion);
    });

    it('active blocks store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const blocks = await appStore.activeBlocksStore.getActiveBlocks();
        expect(blocks).toEqual([]);
    });

    it('security events store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events).toEqual([]);
    });

    it('api token store is functional', async () => {
        const appStore = createAppStore(createInMemoryDatabase());
        const token = await appStore.apiTokenStore.getApiToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('exposes recordSecurityViolation', () => {
        const appStore = createAppStore(createInMemoryDatabase());
        expect(typeof appStore.recordSecurityViolation).toBe('function');
    });
});

describe('recordSecurityViolation', () => {
    function createStore(env = {}) {
        return createAppStore(createInMemoryDatabase(), env);
    }

    const mismatchDetails = {
        status: VERIFICATION_STATUS.MISMATCH,
        fileKey: '/app.js',
        url: 'https://example.com/app.js',
        expectedHash: 'aaaa1111bbbb2222',
        actualHash: 'cccc3333dddd4444',
        assetType: 'asset',
    };

    it('returns mustBlock=true when a mismatch violation adds a new active block', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation(mismatchDetails);
        expect(mustBlock).toBe(true);
    });

    it('returns mustBlock=false for a recurrence of a known block', async () => {
        const appStore = createStore();
        await appStore.recordSecurityViolation(mismatchDetails);
        const mustBlock = await appStore.recordSecurityViolation(mismatchDetails);
        expect(mustBlock).toBe(false);
    });

    it('stores the security event', async () => {
        const appStore = createStore({ userAgent: 'test-ua', origin: 'https://example.com' });
        await appStore.recordSecurityViolation(mismatchDetails);

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events.length).toBe(1);
        expect(events[0].status).toBe('MISMATCH');
        expect(events[0].userAgent).toBe('test-ua');
        expect(events[0].origin).toBe('https://example.com');
    });

    it('logs every violation event (including recurrences)', async () => {
        const appStore = createStore();
        await appStore.recordSecurityViolation(mismatchDetails);
        await appStore.recordSecurityViolation(mismatchDetails);

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events.length).toBe(2);
    });

    it('stores an active block', async () => {
        const appStore = createStore();
        await appStore.recordSecurityViolation(mismatchDetails);

        const blocks = await appStore.activeBlocksStore.getActiveBlocks();
        expect(blocks.length).toBe(1);
        expect(blocks[0].fileKey).toBe('/app.js');
    });

    it('logs MATCH violations without error', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.MATCH,
        });
        expect(mustBlock).toBe(true);
    });

    it('handles NOT_FOUND_IN_MANIFEST violation', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST,
        });
        expect(mustBlock).toBe(true);
    });

    it('handles unknown violation types', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation({
            ...mismatchDetails,
            status: { description: 'UNKNOWN_TYPE', isViolation: true },
        });
        expect(mustBlock).toBe(true);
    });

    it('lines 59-60: handles VERIFICATION_STATUS.ERROR without throwing', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation({
            ...mismatchDetails,
            status: VERIFICATION_STATUS.ERROR,
        });
        expect(mustBlock).toBe(true);
    });

    it('lines 59-60: else branch with undefined url and fileKey uses N/A fallbacks', async () => {
        const appStore = createStore();
        const mustBlock = await appStore.recordSecurityViolation({
            status: VERIFICATION_STATUS.ERROR,
            url: undefined,
            fileKey: undefined,
            assetType: 'asset',
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
        const appStore = createAppStore(db);
        const mustBlock = await appStore.recordSecurityViolation(mismatchDetails);
        expect(mustBlock).toBe(true);
    });

    it('fail-safes to mustBlock=true when outer recordSecurityBlock call throws', async () => {
        const db = createInMemoryDatabase();
        const appStore = createAppStore(db);
        const details = {
            status: null,
            fileKey: '/bad.js',
            url: 'https://example.com/bad.js',
            assetType: 'asset',
        };
        const mustBlock = await appStore.recordSecurityViolation(details);
        expect(mustBlock).toBe(true);
    });

    it('handles securityEventsStore.logSecurityEvent throwing directly', async () => {
        const db = createInMemoryDatabase();
        const appStore = createAppStore(db);
        appStore.securityEventsStore.logSecurityEvent = async () => {
            throw new Error('direct logSecurityEvent failure');
        };
        const mustBlock = await appStore.recordSecurityViolation(mismatchDetails);
        expect(mustBlock).toBe(true);
    });
});
