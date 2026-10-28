import { describe, it, expect, beforeEach } from 'vitest';
import { createSecurityStore, generateBlockId } from '../storage/security-store.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createInMemoryDb } from './helpers/in-memory-db.js';

const DETAILS = {
    status: VERIFICATION_STATUS.FILE_UNTRUSTED,
    reason: 'HASH_MISMATCH',
    fileKey: '/app.js',
    expectedHashes: ['expected123'],
    actualHash: 'actual456',
    assetType: 'ASSET',
};

const DETAILS_2 = {
    status: VERIFICATION_STATUS.FILE_UNTRUSTED,
    reason: 'HASH_MISMATCH',
    fileKey: '/style.css',
    expectedHashes: ['expectedABC'],
    actualHash: 'actualDEF',
    assetType: 'ASSET',
};

describe('createSecurityStore', () => {
    let store;

    beforeEach(() => {
        store = createSecurityStore(createInMemoryDb());
    });

    describe('recordSecurityViolation', () => {
        it('returns mustBlock=true for a brand-new block', async () => {
            const mustBlock = await store.recordSecurityViolation(DETAILS);
            expect(mustBlock).toBe(true);
        });

        it('returns mustBlock=false on duplicate (already-recorded block)', async () => {
            await store.recordSecurityViolation(DETAILS);
            const mustBlock = await store.recordSecurityViolation(DETAILS);
            expect(mustBlock).toBe(false);
        });

        it('increments occurrenceCount on recurrence', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS);

            const blocks = await store.getActiveBlocks();
            expect(blocks).toHaveLength(1);
            expect(blocks[0].occurrenceCount).toBe(2);
        });

        it('updates lastSeen on recurrence', async () => {
            await store.recordSecurityViolation(DETAILS);
            const [firstRecord] = await store.getActiveBlocks();
            await new Promise((r) => setTimeout(r, 5));
            await store.recordSecurityViolation(DETAILS);
            const [secondRecord] = await store.getActiveBlocks();
            expect(secondRecord.lastSeen >= firstRecord.lastSeen).toBe(true);
        });

        it('assigns distinct IDs to distinct violations', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS_2);
            const blocks = await store.getActiveBlocks();
            expect(blocks.map((b) => b.fileKey).sort()).toEqual(['/app.js', '/style.css']);
        });

        it('fails safe: returns mustBlock=true on storage errors', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => {
                            throw new Error('storage unavailable');
                        },
                        put: async () => {},
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            const mustBlock = await brokenStore.recordSecurityViolation(DETAILS);
            expect(mustBlock).toBe(true);
        });
    });

    describe('isBlocked', () => {
        it('returns false when no blocks exist', async () => {
            expect(await store.isBlocked()).toBe(false);
        });

        it('returns true when a block is active', async () => {
            await store.recordSecurityViolation(DETAILS);
            expect(await store.isBlocked()).toBe(true);
        });

        it('returns false after clearBlockCondition', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.clearBlockCondition();
            expect(await store.isBlocked()).toBe(false);
        });
    });

    describe('getAllBlocks', () => {
        it('returns an empty array when no blocks exist', async () => {
            expect(await store.getAllBlocks()).toEqual([]);
        });

        it('returns every block record annotated with active state', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS_2);
            await store.clearBlockCondition();
            await store.recordSecurityViolation(DETAILS); // recurrence, still cleared

            const all = await store.getAllBlocks();
            expect(all).toHaveLength(2);
            expect(all.every((b) => b.active === false)).toBe(true);
            expect(all.map((b) => b.fileKey).sort()).toEqual(['/app.js', '/style.css']);
        });

        it('marks currently-active blocks with active: true', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS_2);

            const all = await store.getAllBlocks();
            expect(all).toHaveLength(2);
            expect(all.every((b) => b.active === true)).toBe(true);
        });

        it('mixes active and cleared blocks when some have been cleared and new ones appeared', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.clearBlockCondition();
            await store.recordSecurityViolation(DETAILS_2);

            const all = await store.getAllBlocks();
            const byFileKey = Object.fromEntries(all.map((b) => [b.fileKey, b.active]));
            expect(byFileKey['/app.js']).toBe(false);
            expect(byFileKey['/style.css']).toBe(true);
        });
    });

    describe('getActiveBlocks', () => {
        it('returns empty array when no blocks exist', async () => {
            expect(await store.getActiveBlocks()).toEqual([]);
        });

        it('returns all active blocks with their data joined', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS_2);

            const blocks = await store.getActiveBlocks();
            expect(blocks).toHaveLength(2);
            expect(blocks[0]).toMatchObject({
                fileKey: '/app.js',
                status: 'FILE_UNTRUSTED',
                reason: 'HASH_MISMATCH',
                occurrenceCount: 1,
            });
            expect(blocks[0].id).toMatch(/^block_[0-9a-f]{16}$/);
        });

        it('returns empty array after clearBlockCondition', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.clearBlockCondition();
            expect(await store.getActiveBlocks()).toEqual([]);
        });
    });

    describe('getSecurityBlock', () => {
        it('returns undefined for unknown block id', async () => {
            const block = await store.getSecurityBlock('block_nonexistent');
            expect(block).toBeUndefined();
        });

        it('returns the block data by id', async () => {
            await store.recordSecurityViolation(DETAILS);
            const [{ id }] = await store.getActiveBlocks();
            const block = await store.getSecurityBlock(id);
            expect(block.id).toBe(id);
            expect(block.fileKey).toBe('/app.js');
        });

        it('still returns data for previously-cleared blocks (history survives)', async () => {
            await store.recordSecurityViolation(DETAILS);
            const [{ id }] = await store.getActiveBlocks();
            await store.clearBlockCondition();

            const block = await store.getSecurityBlock(id);
            expect(block).toBeDefined();
            expect(block.fileKey).toBe('/app.js');
        });
    });

    describe('policy: recurrences of cleared blocks stay cleared', () => {
        it('does not re-activate a previously-cleared block on recurrence', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.clearBlockCondition();

            const mustBlock = await store.recordSecurityViolation(DETAILS);
            expect(mustBlock).toBe(false);
            expect(await store.isBlocked()).toBe(false);
        });

        it('still bumps occurrenceCount on cleared-block recurrences', async () => {
            await store.recordSecurityViolation(DETAILS);
            const [{ id }] = await store.getActiveBlocks();
            await store.clearBlockCondition();

            await store.recordSecurityViolation(DETAILS);
            const block = await store.getSecurityBlock(id);
            expect(block.occurrenceCount).toBe(2);
        });

        it('new violations after clearing do re-activate blocking', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.clearBlockCondition();

            const mustBlock = await store.recordSecurityViolation(DETAILS_2);
            expect(mustBlock).toBe(true);
            expect(await store.isBlocked()).toBe(true);
        });
    });

    describe('clearBlockCondition', () => {
        it('removes all active blocks in one call', async () => {
            await store.recordSecurityViolation(DETAILS);
            await store.recordSecurityViolation(DETAILS_2);
            await store.clearBlockCondition();

            expect(await store.getActiveBlocks()).toEqual([]);
        });

        it('is idempotent', async () => {
            await store.clearBlockCondition();
            await store.clearBlockCondition();
            expect(await store.isBlocked()).toBe(false);
        });

        it('does not throw when activeBlocks.put rejects', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => undefined,
                        put: async () => {
                            throw new Error('put failed');
                        },
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            await expect(brokenStore.clearBlockCondition()).resolves.not.toThrow();
        });
    });

    describe('getSecurityBlock error path', () => {
        it('does not throw when activeBlocks.get rejects', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => {
                            throw new Error('get failed');
                        },
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            const result = await brokenStore.getSecurityBlock('block_id');
            expect(result).toBeUndefined();
        });
    });

    describe('getActiveBlocks error path', () => {
        it('returns empty array when activeBlocks.get rejects', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => {
                            throw new Error('get failed');
                        },
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            const result = await brokenStore.getActiveBlocks();
            expect(result).toEqual([]);
        });

        it('line 135: getActiveBlocks handles missing blocks key gracefully', async () => {
            const map = new Map();
            map.set('active-block-ids', ['block_fake_id_here']);
            const withTx = async (fn) =>
                fn({
                    activeBlocks: {
                        get: async (key) => map.get(key),
                        put: async (value, key) => {
                            map.set(key, value);
                        },
                    },
                });
            const s = createSecurityStore(withTx);
            const result = await s.getActiveBlocks();
            expect(result).toEqual([]);
        });
    });

    describe('recordSecurityViolation occurrenceCount edge cases', () => {
        it('line 85: occurrenceCount || 0 branch handles existing block with occurrenceCount=0', async () => {
            const details = {
                status: VERIFICATION_STATUS.FILE_UNTRUSTED,
                reason: 'HASH_MISMATCH',
                fileKey: '/app.js',
                expectedHashes: ['expected123'],
                actualHash: 'actual456',
                assetType: 'ASSET',
            };
            const blockData = { ...details, status: details.status.description };
            const blockId = await generateBlockId(blockData);
            const store = new Map();
            store.set('blocks', {
                [blockId]: {
                    ...blockData,
                    id: blockId,
                    occurrenceCount: 0,
                    timestamp: new Date().toISOString(),
                    lastSeen: new Date().toISOString(),
                },
            });
            store.set('active-block-ids', [blockId]);
            const runScoped = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async (key) => store.get(key),
                        put: async (value, key) => {
                            store.set(key, value);
                        },
                    },
                });
            const s = createSecurityStore({ read: runScoped, write: runScoped });
            const mustBlock = await s.recordSecurityViolation(details);
            expect(mustBlock).toBe(false);
            const blocks = await s.getActiveBlocks();
            expect(blocks[0].occurrenceCount).toBe(1);
        });
    });

    describe('isBlocked error path', () => {
        it('returns false when activeBlocks.get rejects', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => {
                            throw new Error('get failed');
                        },
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            const result = await brokenStore.isBlocked();
            expect(result).toBe(false);
        });
    });

    describe('getAllBlocks error path', () => {
        it('returns empty array when activeBlocks.get rejects', async () => {
            const brokenRun = async (_stores, fn) =>
                fn({
                    activeBlocks: {
                        get: async () => {
                            throw new Error('get failed');
                        },
                    },
                });
            const brokenStore = createSecurityStore({ read: brokenRun, write: brokenRun });
            const result = await brokenStore.getAllBlocks();
            expect(result).toEqual([]);
        });
    });
});
