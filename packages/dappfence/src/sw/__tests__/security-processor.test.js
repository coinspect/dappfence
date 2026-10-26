import { describe, it, expect, vi } from 'vitest';
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

function createSwContext({
    userAgent = 'test-ua',
    origin = 'https://example.com',
    fetch = vi.fn(),
    registerSync = vi.fn().mockResolvedValue(undefined),
} = {}) {
    return {
        getUserAgent: () => userAgent,
        getLocationOrigin: () => origin,
        fetch,
        registerSync,
    };
}

function createManifestService({ telemetryUrl = null, appVersion = null } = {}) {
    return {
        resolveManifest: vi.fn().mockResolvedValue({ telemetryUrl, appVersion }),
    };
}

function createProcessor({
    db = createInMemoryDatabase(),
    swContext = createSwContext(),
    manifestService = createManifestService(),
} = {}) {
    const appStore = createAppStore(db);
    const securityProcessor = createSecurityProcessor({ swContext, appStore, manifestService });
    return { appStore, securityProcessor, manifestService, swContext };
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

    it('stores the security event (after drain)', async () => {
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ userAgent: 'test-ua', origin: 'https://example.com' }),
        });
        await processAndDrain(securityProcessor, mismatchDetails);

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events.length).toBe(1);
        expect(events[0].status).toBe('FILE_UNTRUSTED');
        expect(events[0].reason).toBe('HASH_MISMATCH');
        expect(events[0].userAgent).toBe('test-ua');
        expect(events[0].origin).toBe('https://example.com');
    });

    it('logs every violation event (including recurrences) after drain', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await processAndDrain(securityProcessor, mismatchDetails);
        await processAndDrain(securityProcessor, mismatchDetails);

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

    it('does not persist SKIPPED to any store', async () => {
        const { securityProcessor, appStore } = createProcessor();
        await processAndDrain(securityProcessor, {
            ...mismatchDetails,
            status: VERIFICATION_STATUS.SKIPPED,
        });

        const events = await appStore.securityEventsStore.getSecurityEvents();
        expect(events).toHaveLength(0);
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

    it('does not crash if event logging fails during drain', async () => {
        const db = createInMemoryDatabase();
        const originalSet = db.set;
        db.set = async (key, value) => {
            if (key === 'security-events') {
                throw new Error('storage full');
            }
            return originalSet(key, value);
        };
        const { securityProcessor } = createProcessor({ db });
        const event = createFetchEvent();
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        await expect(securityProcessor.reportAfterFetch(event)).resolves.toBeUndefined();
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

    it('handles securityEventsStore.logSecurityEvent throwing directly during drain', async () => {
        const { securityProcessor, appStore } = createProcessor();
        appStore.securityEventsStore.logSecurityEvent = async () => {
            throw new Error('direct logSecurityEvent failure');
        };
        const event = createFetchEvent();
        const mustBlock = await securityProcessor.processSecurityEvent(mismatchDetails);
        await expect(securityProcessor.reportAfterFetch(event)).resolves.toBeUndefined();
        expect(mustBlock).toBe(true);
    });

    describe('expectedHashes array contract (shape from verifier)', () => {
        it('persists expectedHashes in the security event', async () => {
            const { securityProcessor, appStore } = createProcessor();
            await processAndDrain(securityProcessor, mismatchDetails);
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

describe('sendPendingReports (via reportAfterFetch)', () => {
    const mismatchDetails = {
        status: VERIFICATION_STATUS.FILE_UNTRUSTED,
        reason: 'HASH_MISMATCH',
        fileKey: '/app.js',
        url: 'https://example.com/app.js',
        expectedHashes: ['aaaa1111'],
        actualHash: 'cccc3333',
        assetType: 'asset',
    };
    const mismatchDetails2 = { ...mismatchDetails, fileKey: '/other.js' };

    const okFetch = () =>
        vi.fn().mockResolvedValue(new Response(null, { status: 204, statusText: 'No Content' }));
    const failFetch = () =>
        vi.fn().mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }));
    const throwFetch = () => vi.fn().mockRejectedValue(new Error('network down'));

    it('skips when telemetryUrl is null (no manifest, no config)', async () => {
        const fetch = okFetch();
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ fetch }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect(fetch).not.toHaveBeenCalled();
        const [block] = await appStore.activeBlocksStore.getActiveBlocks();
        expect(block.reportedAt).toBeNull();
    });

    it('skips when there are no pending blocks', async () => {
        const fetch = okFetch();
        const { securityProcessor } = createProcessor({
            swContext: createSwContext({ fetch }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('POSTs a batched envelope and marks blocks reported on 2xx', async () => {
        const fetch = okFetch();
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({
                fetch,
                userAgent: 'ua-x',
                origin: 'https://x.example',
            }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs.example/collect',
                appVersion: 'v-42',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.processSecurityEvent(mismatchDetails2);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('https://logs.example/collect');
        expect(init.method).toBe('POST');
        expect(init.keepalive).toBe(true);
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
            appVersion: 'v-42',
            origin: 'https://x.example',
            userAgent: 'ua-x',
        });
        expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.events).toHaveLength(2);
        expect(body.events.map((e) => e.fileKey).sort()).toEqual(['/app.js', '/other.js']);

        const blocks = await appStore.activeBlocksStore.getAllBlocks();
        expect(blocks.every((b) => b.reportedAt === body.sentAt)).toBe(true);
        expect(await appStore.activeBlocksStore.getPendingReportBlocks()).toEqual([]);
    });

    it('leaves blocks unreported AND registers a sync retry when POST returns non-2xx', async () => {
        const fetch = failFetch();
        const registerSync = vi.fn().mockResolvedValue(undefined);
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ fetch, registerSync }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(registerSync).toHaveBeenCalledWith('dappfence-report-events');
        const [block] = await appStore.activeBlocksStore.getPendingReportBlocks();
        expect(block.fileKey).toBe('/app.js');
        expect(block.reportedAt).toBeNull();
    });

    it('reportOnSync throws on POST failure so Chromium Background Sync retries', async () => {
        const { securityProcessor } = createProcessor({
            swContext: createSwContext({ fetch: failFetch() }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await expect(
            securityProcessor.reportOnSync({ tag: 'dappfence-report-events', lastChance: false })
        ).rejects.toThrow(/POST failed/);
    });

    it('reportOnSync drives the drain and clears pending on success', async () => {
        // First POST fails (500) → sync registered, block stays pending.
        // Then reportOnSync fires with fetch now succeeding → block marked.
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 500 }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ fetch }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect((await appStore.activeBlocksStore.getPendingReportBlocks()).length).toBe(1);

        await securityProcessor.reportOnSync({
            tag: 'dappfence-report-events',
            lastChance: false,
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await appStore.activeBlocksStore.getPendingReportBlocks()).toEqual([]);
    });

    it('swallows fetch exceptions and leaves blocks unreported', async () => {
        const fetch = throwFetch();
        const { securityProcessor, appStore } = createProcessor({
            swContext: createSwContext({ fetch }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await expect(
            securityProcessor.reportAfterFetch({
                request: { mode: 'no-cors' },
                clientId: 'c1',
                resultingClientId: '',
            })
        ).resolves.toBeUndefined();
        const pending = await appStore.activeBlocksStore.getPendingReportBlocks();
        expect(pending).toHaveLength(1);
    });

    it('a successful send then a recurrence re-triggers no POST (dedup via reportedAt)', async () => {
        const fetch = okFetch();
        const { securityProcessor } = createProcessor({
            swContext: createSwContext({ fetch }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect(fetch).toHaveBeenCalledTimes(1);

        // recurrence: same block id, reportedAt stays stamped, nothing new to POST
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterFetch({
            request: { mode: 'no-cors' },
            clientId: 'c1',
            resultingClientId: '',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('reportAfterInstall also drives sendPendingReports', async () => {
        const fetch = okFetch();
        const { securityProcessor } = createProcessor({
            swContext: createSwContext({ fetch }),
            manifestService: createManifestService({
                telemetryUrl: 'https://logs/',
                appVersion: 'v1',
            }),
        });
        await securityProcessor.processSecurityEvent(mismatchDetails);
        await securityProcessor.reportAfterInstall();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
