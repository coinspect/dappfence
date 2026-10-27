/**
 * API Token Store
 *
 * The SW generates a per-install bearer token at first access and holds it
 * for the SW's lifetime. Secure /sw-api/* endpoints validate requests
 * against it. Token never rotates.
 *
 * Uses dependency injection: createApiTokenStore(database) takes a
 * { db } interface, making it testable with in-memory backends.
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const API_TOKEN_KEY = 'API_TOKEN_KEY';

/**
 * @param {import('./indexeddb.js').Database} db
 */
export function createApiTokenStore(db) {
    // The token is generated once and never rotates for the SW's lifetime, so
    // we memoize the first getApiToken() promise: subsequent callers await the
    // same resolved promise instead of hitting IndexedDB per request.
    let cached = null;
    async function getApiToken() {
        if (!cached) {
            cached = db(
                async ({ settings }) => {
                    const key = await settings.get(API_TOKEN_KEY);
                    if (key) {
                        logger.log('Reusing API token for secure endpoints', key);
                        return key;
                    }
                    const array = new Uint8Array(32);
                    crypto.getRandomValues(array);
                    const tokenKey = Array.from(array, (byte) =>
                        byte.toString(16).padStart(2, '0')
                    ).join('');
                    logger.log('API token for secure endpoints', tokenKey);
                    await settings.put(tokenKey, API_TOKEN_KEY);
                    return tokenKey;
                },
                { mode: 'readwrite' }
            );
        }
        return cached;
    }

    return { getApiToken };
}
