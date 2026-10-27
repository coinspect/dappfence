/**
 * Settings Store
 *
 * Per-install singletons kept in the `settings` object store. Each value is
 * generated once on first access and preserved for the SW's lifetime:
 *
 *   - API token: bearer used by secure /sw-api/* endpoints.
 *   - Session id: stable UUID tagged onto outgoing telemetry.
 *
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const API_TOKEN_KEY = 'API_TOKEN_KEY';
const SESSION_ID_KEY = 'SESSION_ID_KEY';

/**
 * @param {import('./indexeddb.js').Database} db
 */
export function createSettingsStore(db) {
    let cachedApiToken = null;
    let cachedSessionId = null;

    async function getApiToken() {
        if (!cachedApiToken) {
            cachedApiToken = db(
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
        return cachedApiToken;
    }

    async function getSessionId() {
        if (!cachedSessionId) {
            cachedSessionId = db(
                async ({ settings }) => {
                    const existing = await settings.get(SESSION_ID_KEY);
                    if (existing) {
                        logger.log('Reusing session id', existing);
                        return existing;
                    }
                    const sessionId = crypto.randomUUID();
                    logger.log('Generated new session id', sessionId);
                    await settings.put(sessionId, SESSION_ID_KEY);
                    return sessionId;
                },
                { mode: 'readwrite' }
            );
        }
        return cachedSessionId;
    }

    return { getApiToken, getSessionId };
}
