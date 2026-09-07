import { createLogger } from '../core/logger.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext - Service worker context wrapper
 * @param {object} deps.config - Parsed URL config (appSW, manifestUrl, etc.)
 * @param {object} deps.manifestService - Manifest verification service
 * @param {function} deps.onInstallDone - Called when install event processing completes
 * @param {object} deps.appStore - App store facade
 * @returns {function} Install event handler (event, callChildHandlers) => Promise<void>
 */
export function createInstallHandler({
    swContext,
    config,
    manifestService,
    onInstallDone,
    appStore,
}) {
    /**
     * When a web app has its own service worker, we load it using `importScripts` but after hooking functions to maintain our code.
     */
    function loadAppServiceWorker() {
        if (!config.appSW) {
            logger.log('Running in standalone mode');
            return;
        }
        try {
            logger.log('Loading app SW:', config.appSW);
            importScripts(config.appSW);
            logger.log('App SW loaded successfully');
        } catch (error) {
            logger.error("Can't import app SW:", error);
        }
    }

    return async (event, callChildHandlers) => {
        try {
            // Skip waiting to become active immediately
            logger.log('skipping waiting for activation');
            await swContext.skipWaiting();

            logger.log('Initializing manifest system');
            const manifestVerificationResult = await manifestService.fetchAndStoreManifest();
            if (manifestVerificationResult.status.isViolation) {
                await appStore.recordSecurityViolation(manifestVerificationResult);
                logger.error('❌ error during initialization: Failed to load manifest');
            } else {
                logger.log(
                    'Manifest system initialized',
                    manifestVerificationResult.appVersion,
                    manifestVerificationResult.manifest.mode
                );
            }
            // Even if manifest verification fails, we proceed to load the child SW. This is intentional because:
            // 1. The child SW may provide critical app functionality
            // 2. Security violations are already recorded and will be reported
            // 3. Blocking the child SW would leave the app in a non-functional state
            // loadAppServiceWorker must be called during `install` and after fetchAndStoreManifest completes, because:
            // 1. We need manifest data to check child service worker integrity
            // 2. importScripts() can only be called during `install`
            logger.log('Loading child service worker app');
            loadAppServiceWorker();

            // Ensure a child service worker has a chance to complete its promise-based operations before proceeding
            await new Promise((resolve) => setTimeout(resolve));
            logger.log('calling child handlers');
            callChildHandlers(event);

            logger.log('Install event done');
            onInstallDone();

            logger.log('Install complete');
        } catch (error) {
            logger.error('❌ error during initialization:', error);
        }
    };
}

/**
 * @param {object} deps
 * @param {object} deps.swContext - Service worker context wrapper
 * @param {function} deps.onSecurityViolation - Called to broadcast the active block condition
 * @param {object} deps.appStore - App store facade
 * @returns {function} Activate event handler (event, callChildHandlers) => Promise<void>
 */
export function createActivateHandler({ swContext, onSecurityViolation, appStore }) {
    const { activeBlocksStore } = appStore;
    return async (event, callChildHandlers) => {
        try {
            logger.log('Activating - claiming all clients');
            await swContext.claimClients();

            logger.log('Activating - start');
            if (await activeBlocksStore.isBlocked()) {
                logger.log('Activating - broadcasting active block condition');
                await onSecurityViolation();
            }

            logger.log('Activating - calling child handlers');
            callChildHandlers(event);

            logger.log('Activating - end');
        } catch (error) {
            logger.error('❌ error during activate:', error);
        }
    };
}
