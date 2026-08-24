/**
 * Security Stores
 * Active blocks tracking, security event logging, and API token management.
 *
 * All stores use dependency injection: each factory takes a { get, set, withTx }
 * database interface, making them testable with in-memory backends.
 */
import { devAssert } from '../../core/utils.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

// --- Active Blocks Store ---
//
// The store separates two concerns:
//   - ACTIVE_BLOCK_IDS_KEY: the blocking *condition* — just a list of IDs.
//   - BLOCKS_KEY: the block *data* — keyed map of violation records.
//
// Clearing only empties the condition; data records persist as history, so
// occurrenceCount keeps accumulating across clear/re-trigger cycles. Once a
// block ID has been seen (exists in the data map), recurrences only bump its
// counters — they never re-enter the active set. Users dismiss blocks in bulk.

const ACTIVE_BLOCK_IDS_KEY = 'active-block-ids';
const BLOCKS_KEY = 'blocks';

/**
 * Generate deterministic block ID using SHA-256 hash.
 * Same violation content = same block ID (prevents duplicates).
 * @param {object} blockData
 * @param {string} blockData.status - Type of security violation
 * @param {string} blockData.fileKey - The file key that triggered the violation
 * @param {string[]} [blockData.expectedHashes] - Expected hashes from manifest
 * @param {string} blockData.actualHash - Actual hash of the file content
 * @returns {Promise<string>} Deterministic block ID like "block_<hash prefix>"
 */
export async function generateBlockId({ status, fileKey, expectedHashes, actualHash, assetType }) {
    devAssert(status && assetType && fileKey);
    const contentKey = `${assetType}_${status}_${fileKey}_${expectedHashes?.join(',') || 'N/A'}_${actualHash || 'N/A'}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(contentKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const hashHex = Array.from(hashArray, (b) => b.toString(16).padStart(2, '0')).join('');
    return `block_${hashHex.substring(0, 16)}`;
}

/**
 * @param {object} database - Store backend with { get, set, withTx }
 */
export function createActiveBlocksStore(database) {
    // In-memory cache: null = unhydrated, boolean = known state.
    // Shared across all tabs (single SW instance). Updated synchronously
    // after every writing so subsequent isBlocked() calls never touch IndexedDB.
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
     * @returns {Promise<boolean>} mustBlock — true if the caller should block the request
     */
    async function recordSecurityBlock(blockData) {
        const blockId = await generateBlockId(blockData);
        const mustBlock = await database.withTx(async (tx) => {
            try {
                const blocks = (await tx.get(BLOCKS_KEY)) || {};
                const activeIds = (await tx.get(ACTIVE_BLOCK_IDS_KEY)) || [];
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

                await tx.set(BLOCKS_KEY, blocks);
                if (mustBlock) {
                    await tx.set(ACTIVE_BLOCK_IDS_KEY, activeIds);
                }
                return mustBlock;
            } catch (error) {
                logger.error(`Failed to record block ${blockId}`, error);
                // Fail-safe: on storage error, tell the caller to block.
                return true;
            }
        });
        if (mustBlock) {
            blocked = true;
        }
        return mustBlock;
    }

    async function isBlocked() {
        try {
            if (blocked === null) {
                const activeIds = (await database.get(ACTIVE_BLOCK_IDS_KEY)) || [];
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
            const activeIds = (await database.get(ACTIVE_BLOCK_IDS_KEY)) || [];
            if (activeIds.length === 0) {
                return [];
            }
            const blocks = (await database.get(BLOCKS_KEY)) || {};
            return activeIds.map((id) => blocks[id]).filter(Boolean);
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
            const blocks = (await database.get(BLOCKS_KEY)) || {};
            const activeIds = new Set((await database.get(ACTIVE_BLOCK_IDS_KEY)) || []);
            return Object.values(blocks).map((block) => ({
                ...block,
                active: activeIds.has(block.id),
            }));
        } catch (error) {
            logger.error('Failed to get all blocks:', error);
            return [];
        }
    }

    async function getSecurityBlock(blockId) {
        try {
            const blocks = (await database.get(BLOCKS_KEY)) || {};
            return blocks[blockId];
        } catch (error) {
            logger.error(`Failed to get block ${blockId}:`, error);
        }
    }

    async function clearBlockCondition() {
        try {
            await database.set(ACTIVE_BLOCK_IDS_KEY, []);
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

// --- Security Events Store ---

const SECURITY_EVENTS_KEY = 'security-events';

/**
 * @param {object} database - Storage backend with { get, set }
 */
export function createSecurityEventsStore(database) {
    async function logSecurityEvent(eventData) {
        try {
            const events = (await database.get(SECURITY_EVENTS_KEY)) || [];
            events.push({
                ...eventData,
                id: `event_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                timestamp: eventData.timestamp || new Date().toISOString(),
            });

            // Keep only last 1000 events to prevent storage bloat
            if (events.length > 1000) {
                events.splice(0, events.length - 1000);
            }
            await database.set(SECURITY_EVENTS_KEY, events);
            logger.log('Security event logged:', eventData.status);
        } catch (error) {
            logger.error('Failed to log security event:', error);
        }
    }

    async function getSecurityEvents(limit = 100) {
        try {
            const events = (await database.get(SECURITY_EVENTS_KEY)) || [];
            return events.slice(-limit).reverse(); // Most recent first
        } catch (error) {
            logger.error('Failed to get security events:', error);
            return [];
        }
    }

    return { logSecurityEvent, getSecurityEvents };
}

// --- API Token Store ---

const API_TOKEN_KEY = 'API_TOKEN_KEY';

/**
 * @param {object} database - Store backend with { withTx }
 */
export function createApiTokenStore(database) {
    async function getApiToken() {
        return await database.withTx(async (tx) => {
            const key = await tx.get(API_TOKEN_KEY);
            if (key) {
                logger.log('Reusing API token for secure endpoints', key);
                return key;
            }
            // put a new key if none exists
            const array = new Uint8Array(32);
            crypto.getRandomValues(array);
            const tokenKey = Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
                ''
            );
            logger.log('API token for secure endpoints', tokenKey);
            await tx.set(API_TOKEN_KEY, tokenKey);
            return tokenKey;
        });
    }

    return { getApiToken };
}
