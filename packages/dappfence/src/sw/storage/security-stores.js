/**
 * Active Blocks Store
 *
 * Tracks per-URL security blocks that gate the fetch handler's mustBlock
 * decision. Separates two concerns:
 *   - ACTIVE_BLOCK_IDS_KEY: the blocking *condition* — just a list of IDs.
 *   - BLOCKS_KEY: the block *data* — keyed map of violation records.
 *
 * Clearing only empties the condition; data records persist as history, so
 * occurrenceCount keeps accumulating across clear/re-trigger cycles. Once a
 * block ID has been seen (exists in the data map), recurrences only bump its
 * counters — they never re-enter the active set. Users dismiss blocks in bulk.
 *
 * Uses dependency injection: createActiveBlocksStore(db) takes a
 * Database function, making it testable with in-memory backends.
 */
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const ACTIVE_BLOCK_IDS_KEY = 'active-block-ids';
const BLOCKS_KEY = 'blocks';

/** @typedef {import('../../core/constants.js').AssetType} AssetType */
/** @typedef {import('../../core/constants.js').VerificationStatus} VerificationStatus */
/** @typedef {import('../../core/constants.js').AssetErrorReason} AssetErrorReason */
/** @typedef {import('../../core/constants.js').FileUntrustedReason} FileUntrustedReason */
/** @typedef {import('../../core/constants.js').ManifestLoadReason} ManifestLoadReason */
/** @typedef {import('../security-processor.js').SecurityEventDetails} SecurityEventDetails */
/** @typedef {VerificationStatus['description']} VerificationStatusName */

/**
 * Block record shape as persisted. Derived from `SecurityEventDetails` by
 * extracting the identity and payload fields; `status` is the string form
 * (`.description`), so IndexedDB structuredClone succeeds. Per-status field
 * invariants (actualHash on hash verdicts, reason on ERROR / MANIFEST_UNTRUSTED,
 * etc.) are statically enforced upstream via `SecurityEventDetails`.
 * @typedef {{
 *   status: VerificationStatusName,
 *   assetType: AssetType,
 *   fileKey: string,
 *   url?: string,
 *   reason?: AssetErrorReason | FileUntrustedReason | ManifestLoadReason,
 *   actualHash?: string,
 *   expectedHashes?: string[],
 *   httpStatus?: number,
 * }} SecurityBlockData
 */

/**
 * Project the processor's `SecurityEventDetails` down to the subset the store
 * persists. Keeps extraction and status-string conversion in one place so callers
 * never hand-pick fields.
 * @param {SecurityEventDetails} details
 * @returns {SecurityBlockData}
 */
function toBlockData(details) {
    return {
        status: details.status.description,
        assetType: details.assetType,
        fileKey: details.fileKey,
        url: details.url,
        reason: details.reason,
        actualHash: details.actualHash,
        expectedHashes: details.expectedHashes,
        httpStatus: details.httpStatus,
    };
}

/**
 * Generate deterministic block ID using SHA-256 hash.
 * Same violation content = same block ID (prevents duplicates).
 * @param {SecurityBlockData} blockData
 * @returns {Promise<string>} Deterministic block ID like "block_<hash prefix>"
 */
export async function generateBlockId({
    status,
    reason,
    fileKey,
    expectedHashes,
    actualHash,
    assetType,
}) {
    const contentKey = `${assetType}_${status}_${reason ?? 'N/A'}_${fileKey}_${expectedHashes?.join(',') || 'N/A'}_${actualHash || 'N/A'}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(contentKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
    return `block_${hashHex.substring(0, 16)}`;
}

/**
 * @param {import('./indexeddb.js').Database} db
 */
export function createActiveBlocksStore(db) {
    // In-memory cache: null = unhydrated, boolean = known state.
    // Shared across all tabs (single SW instance). Updated synchronously
    // after every writing so later isBlocked() calls never touch IndexedDB.
    let blocked = null;

    /**
     * Upsert the block record and add its ID to the active set iff it's brand new.
     * Recurrences of known blocks (including previously cleared ones) only bump
     * occurrenceCount / lastSeen — they do not re-activate the blocking condition.
     *
     * Return semantics are caller-facing (what should the caller do?), not internal:
     * true means "block the current request", regardless of whether that's because
     * we just added it to the active set or because we couldn't write and want to
     * fail-safe.
     * @param {SecurityEventDetails} details
     * @returns {Promise<boolean>} mustBlock — true if the caller should block the request
     */
    async function recordSecurityBlock(details) {
        const blockData = toBlockData(details);
        const blockId = await generateBlockId(blockData);
        const mustBlock = await db(
            async ({ activeBlocks }) => {
                try {
                    const blocks = (await activeBlocks.get(BLOCKS_KEY)) || {};
                    const activeIds = (await activeBlocks.get(ACTIVE_BLOCK_IDS_KEY)) || [];
                    const now = new Date().toISOString();
                    const existing = blocks[blockId];
                    let mustBlock = false;

                    if (existing) {
                        blocks[blockId] = {
                            ...existing,
                            ...blockData,
                            id: blockId,
                            lastSeen: now,
                            occurrenceCount: (existing.occurrenceCount || 0) + 1,
                        };
                    } else {
                        blocks[blockId] = {
                            ...blockData,
                            id: blockId,
                            timestamp: now,
                            lastSeen: now,
                            occurrenceCount: 1,
                        };
                        activeIds.push(blockId);
                        mustBlock = true;
                    }

                    await activeBlocks.put(blocks, BLOCKS_KEY);
                    if (mustBlock) {
                        await activeBlocks.put(activeIds, ACTIVE_BLOCK_IDS_KEY);
                    }
                    return mustBlock;
                } catch (error) {
                    logger.error(`Failed to record block ${blockId}`, error);
                    // Fail-safe: on storage error, tell the caller to block.
                    return true;
                }
            },
            { mode: 'readwrite' }
        );
        if (mustBlock) {
            blocked = true;
        }
        return mustBlock;
    }

    async function isBlocked() {
        try {
            if (blocked === null) {
                const activeIds =
                    (await db(({ activeBlocks }) => activeBlocks.get(ACTIVE_BLOCK_IDS_KEY))) || [];
                blocked = activeIds.length > 0;
            }
            return blocked;
        } catch (error) {
            logger.error('Failed to read active block ids:', error);
            return false;
        }
    }

    async function getActiveBlocks() {
        try {
            return await db(async ({ activeBlocks }) => {
                const activeIds = (await activeBlocks.get(ACTIVE_BLOCK_IDS_KEY)) || [];
                if (activeIds.length === 0) {
                    return [];
                }
                const blocks = (await activeBlocks.get(BLOCKS_KEY)) || {};
                return activeIds.map((id) => blocks[id]).filter(Boolean);
            });
        } catch (error) {
            logger.error('Failed to get active blocks:', error);
            return [];
        }
    }

    /**
     * Returns every block record ever seen (active and cleared), each annotated
     * with `active: boolean`. Use this for history/audit views like /sw-api/status.
     */
    async function getAllBlocks() {
        try {
            return await db(async ({ activeBlocks }) => {
                const blocks = (await activeBlocks.get(BLOCKS_KEY)) || {};
                const activeIds = new Set((await activeBlocks.get(ACTIVE_BLOCK_IDS_KEY)) || []);
                return Object.values(blocks).map((block) => ({
                    ...block,
                    active: activeIds.has(block.id),
                }));
            });
        } catch (error) {
            logger.error('Failed to get all blocks:', error);
            return [];
        }
    }

    async function getSecurityBlock(blockId) {
        try {
            const blocks = (await db(({ activeBlocks }) => activeBlocks.get(BLOCKS_KEY))) || {};
            return blocks[blockId];
        } catch (error) {
            logger.error(`Failed to get block ${blockId}:`, error);
        }
    }

    async function clearBlockCondition() {
        try {
            await db(({ activeBlocks }) => activeBlocks.put([], ACTIVE_BLOCK_IDS_KEY), {
                mode: 'readwrite',
            });
            blocked = false;
            logger.log('Block condition cleared');
        } catch (error) {
            logger.error('Failed to clear block condition:', error);
        }
    }

    return {
        recordSecurityBlock,
        isBlocked,
        getActiveBlocks,
        getAllBlocks,
        getSecurityBlock,
        clearBlockCondition,
    };
}
