import { describe, it, expect, beforeEach } from 'vitest';
import { createActiveBlocksStore, generateBlockId } from '../storage/security-stores.js';

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

const BLOCK_DATA = {
    status: 'MISMATCH',
    fileKey: '/app.js',
    expectedHashes: ['expected123'],
    actualHash: 'actual456',
    assetType: 'ASSET',
};

const BLOCK_DATA_2 = {
    status: 'MISMATCH',
    fileKey: '/style.css',
    expectedHashes: ['expectedABC'],
    actualHash: 'actualDEF',
    assetType: 'ASSET',
};

describe('createActiveBlocksStore', () => {
    let store;

    beforeEach(() => {
        store = createActiveBlocksStore(createInMemoryDatabase());
    });

    describe('recordSecurityBlock', () => {
        it('returns mustBlock=true for a brand-new block', async () => {
            const mustBlock = await store.recordSecurityBlock(BLOCK_DATA);
            expect(mustBlock).toBe(true);
        });

        it('returns mustBlock=false on duplicate (already-recorded block)', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            const mustBlock = await store.recordSecurityBlock(BLOCK_DATA);
            expect(mustBlock).toBe(false);
        });

        it('increments occurrenceCount on recurrence', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA);

            const blocks = await store.getActiveBlocks();
            expect(blocks).toHaveLength(1);
            expect(blocks[0].occurrenceCount).toBe(2);
        });

        it('updates lastSeen on recurrence', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            const [firstRecord] = await store.getActiveBlocks();
            await new Promise((r) => setTimeout(r, 5));
            await store.recordSecurityBlock(BLOCK_DATA);
            const [secondRecord] = await store.getActiveBlocks();
            expect(secondRecord.lastSeen >= firstRecord.lastSeen).toBe(true);
        });

        it('assigns distinct IDs to distinct violations', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA_2);
            const blocks = await store.getActiveBlocks();
            expect(blocks.map((b) => b.fileKey).sort()).toEqual(['/app.js', '/style.css']);
        });

        it('fails safe: returns mustBlock=true on storage errors', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('storage unavailable');
                },
                set: async () => {},
                withTx: async (fn) => {
                    return fn({
                        get: async () => {
                            throw new Error('storage unavailable');
                        },
                        set: async () => {},
                    });
                },
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            const mustBlock = await brokenStore.recordSecurityBlock(BLOCK_DATA);
            expect(mustBlock).toBe(true);
        });
    });

    describe('isBlocked', () => {
        it('returns false when no blocks exist', async () => {
            expect(await store.isBlocked()).toBe(false);
        });

        it('returns true when a block is active', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            expect(await store.isBlocked()).toBe(true);
        });

        it('returns false after clearBlockCondition', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.clearBlockCondition();
            expect(await store.isBlocked()).toBe(false);
        });
    });

    describe('getAllBlocks', () => {
        it('returns an empty array when no blocks exist', async () => {
            expect(await store.getAllBlocks()).toEqual([]);
        });

        it('returns every block record annotated with active state', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA_2);
            await store.clearBlockCondition();
            await store.recordSecurityBlock(BLOCK_DATA); // recurrence, still cleared

            const all = await store.getAllBlocks();
            expect(all).toHaveLength(2);
            expect(all.every((b) => b.active === false)).toBe(true);
            expect(all.map((b) => b.fileKey).sort()).toEqual(['/app.js', '/style.css']);
        });

        it('marks currently-active blocks with active: true', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA_2);

            const all = await store.getAllBlocks();
            expect(all).toHaveLength(2);
            expect(all.every((b) => b.active === true)).toBe(true);
        });

        it('mixes active and cleared blocks when some have been cleared and new ones appeared', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.clearBlockCondition();
            await store.recordSecurityBlock(BLOCK_DATA_2);

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
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA_2);

            const blocks = await store.getActiveBlocks();
            expect(blocks).toHaveLength(2);
            expect(blocks[0]).toMatchObject({
                fileKey: '/app.js',
                status: 'MISMATCH',
                occurrenceCount: 1,
            });
            expect(blocks[0].id).toMatch(/^block_[0-9a-f]{16}$/);
        });

        it('returns empty array after clearBlockCondition', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
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
            await store.recordSecurityBlock(BLOCK_DATA);
            const [{ id }] = await store.getActiveBlocks();
            const block = await store.getSecurityBlock(id);
            expect(block.id).toBe(id);
            expect(block.fileKey).toBe('/app.js');
        });

        it('still returns data for previously-cleared blocks (history survives)', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            const [{ id }] = await store.getActiveBlocks();
            await store.clearBlockCondition();

            const block = await store.getSecurityBlock(id);
            expect(block).toBeDefined();
            expect(block.fileKey).toBe('/app.js');
        });
    });

    describe('policy: recurrences of cleared blocks stay cleared', () => {
        it('does not re-activate a previously-cleared block on recurrence', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.clearBlockCondition();

            const mustBlock = await store.recordSecurityBlock(BLOCK_DATA);
            expect(mustBlock).toBe(false);
            expect(await store.isBlocked()).toBe(false);
        });

        it('still bumps occurrenceCount on cleared-block recurrences', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            const [{ id }] = await store.getActiveBlocks();
            await store.clearBlockCondition();

            await store.recordSecurityBlock(BLOCK_DATA);
            const block = await store.getSecurityBlock(id);
            expect(block.occurrenceCount).toBe(2);
        });

        it('new violations after clearing do re-activate blocking', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.clearBlockCondition();

            const mustBlock = await store.recordSecurityBlock(BLOCK_DATA_2);
            expect(mustBlock).toBe(true);
            expect(await store.isBlocked()).toBe(true);
        });
    });

    describe('clearBlockCondition', () => {
        it('removes all active blocks in one call', async () => {
            await store.recordSecurityBlock(BLOCK_DATA);
            await store.recordSecurityBlock(BLOCK_DATA_2);
            await store.clearBlockCondition();

            expect(await store.getActiveBlocks()).toEqual([]);
        });

        it('is idempotent', async () => {
            await store.clearBlockCondition();
            await store.clearBlockCondition();
            expect(await store.isBlocked()).toBe(false);
        });

        it('does not throw when database.set rejects', async () => {
            const brokenDb = {
                get: async () => [],
                set: async () => {
                    throw new Error('set failed');
                },
                withTx: async (fn) =>
                    fn({
                        get: async () => undefined,
                        set: async () => {},
                    }),
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            await expect(brokenStore.clearBlockCondition()).resolves.not.toThrow();
        });
    });

    describe('getSecurityBlock error path', () => {
        it('does not throw when database.get rejects', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('get failed');
                },
                set: async () => {},
                withTx: async (fn) =>
                    fn({
                        get: async () => undefined,
                        set: async () => {},
                    }),
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            const result = await brokenStore.getSecurityBlock('block_id');
            expect(result).toBeUndefined();
        });
    });

    describe('getActiveBlocks error path', () => {
        it('returns empty array when database.get rejects', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('get failed');
                },
                set: async () => {},
                withTx: async (fn) =>
                    fn({
                        get: async () => undefined,
                        set: async () => {},
                    }),
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            const result = await brokenStore.getActiveBlocks();
            expect(result).toEqual([]);
        });

        it('line 135: getActiveBlocks handles missing blocks key gracefully', async () => {
            const store = new Map();
            store.set('active-block-ids', ['block_fake_id_here']);
            const db = {
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
                withTx: async (fn) =>
                    fn({
                        get: async (key) => store.get(key),
                        set: async (key, value) => store.set(key, value),
                    }),
            };
            const s = createActiveBlocksStore(db);
            const result = await s.getActiveBlocks();
            expect(result).toEqual([]);
        });
    });

    describe('recordSecurityBlock occurrenceCount edge cases', () => {
        it('line 85: occurrenceCount || 0 branch handles existing block with occurrenceCount=0', async () => {
            const blockData = {
                status: 'MISMATCH',
                fileKey: '/app.js',
                expectedHashes: ['expected123'],
                actualHash: 'actual456',
                assetType: 'ASSET',
            };
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
            const db = {
                get: async (key) => store.get(key),
                set: async (key, value) => store.set(key, value),
                withTx: async (fn) =>
                    fn({
                        get: async (key) => store.get(key),
                        set: async (key, value) => store.set(key, value),
                    }),
            };
            const s = createActiveBlocksStore(db);
            const mustBlock = await s.recordSecurityBlock(blockData);
            expect(mustBlock).toBe(false);
            const blocks = await s.getActiveBlocks();
            expect(blocks[0].occurrenceCount).toBe(1);
        });
    });

    describe('isBlocked error path', () => {
        it('returns false when database.get rejects', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('get failed');
                },
                set: async () => {},
                withTx: async (fn) =>
                    fn({
                        get: async () => undefined,
                        set: async () => {},
                    }),
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            const result = await brokenStore.isBlocked();
            expect(result).toBe(false);
        });
    });

    describe('getAllBlocks error path', () => {
        it('returns empty array when database.get rejects', async () => {
            const brokenDb = {
                get: async () => {
                    throw new Error('get failed');
                },
                set: async () => {},
                withTx: async (fn) =>
                    fn({
                        get: async () => undefined,
                        set: async () => {},
                    }),
            };
            const brokenStore = createActiveBlocksStore(brokenDb);
            const result = await brokenStore.getAllBlocks();
            expect(result).toEqual([]);
        });
    });
});
