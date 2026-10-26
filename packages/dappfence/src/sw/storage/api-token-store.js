/**
 * API Token Store
 *
 * The SW generates a per-install bearer token at first access and holds it
 * for the SW's lifetime. Secure /sw-api/* endpoints validate requests
 * against it. Token never rotates.
 *
 * Uses dependency injection: createApiTokenStore(database) takes a
 * { withTx } interface, making it testable with in-memory backends.
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const API_TOKEN_KEY = 'API_TOKEN_KEY';

/**
 * @param {object} database - Store backend with { withTx }
 */
export function createApiTokenStore(database) {
    // The token is generated once and never rotates for the SW's lifetime, so
    // we memoize the first getApiToken() promise: subsequent callers await the
    // same resolved promise instead of hitting IndexedDB per request.
    let cached = null;
    async function getApiToken() {
        if (!cached) {
            cached = database.withTx(async (tx) => {
                const key = await tx.get(API_TOKEN_KEY);
                if (key) {
                    logger.log('Reusing API token for secure endpoints', key);
                    return key;
                }
                // put a new key if none exists
                const array = new Uint8Array(32);
                crypto.getRandomValues(array);
                const tokenKey = Array.from(array, (byte) =>
                    byte.toString(16).padStart(2, '0')
                ).join('');
                logger.log('API token for secure endpoints', tokenKey);
                await tx.set(API_TOKEN_KEY, tokenKey);
                return tokenKey;
            });
        }
        return cached;
    }

    return { getApiToken };
}
