/**
 * Settings Store
 *
 * Per-install singletons kept in the `settings` object store. Each value is
 * generated once on first access and preserved for the SW's lifetime:
 *
 *   - API token: bearer used by secure /sw-api/* endpoints.
 *   - Installation time: millisecond timestamp of this install's first access,
 *     tagged onto outgoing telemetry. Identifies the install cohort (same
 *     client across sessions and reloads) without identifying the user.
 */

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const API_TOKEN_KEY = 'API_TOKEN_KEY';
const INSTALLATION_TIME_KEY = 'INSTALLATION_TIME_KEY';

/**
 * @param {import('./indexeddb.js').DbHandle} db
 */
export function createSettingsStore(db) {
    let cachedApiToken = null;
    let cachedInstallationTime = null;

    async function getApiToken() {
        if (!cachedApiToken) {
            cachedApiToken = db.write(['settings'], async ({ settings }) => {
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
            });
        }
        return cachedApiToken;
    }

    async function getInstallationTime() {
        if (!cachedInstallationTime) {
            cachedInstallationTime = db.write(['settings'], async ({ settings }) => {
                const existing = await settings.get(INSTALLATION_TIME_KEY);
                if (existing) {
                    logger.log('Reusing installation time', existing);
                    return existing;
                }
                const installationTime = Date.now();
                logger.log('Recorded installation time', installationTime);
                await settings.put(installationTime, INSTALLATION_TIME_KEY);
                return installationTime;
            });
        }
        return cachedInstallationTime;
    }

    return { getApiToken, getInstallationTime };
}
