/**
 * DappFence Main Entry Point
 * Detects context and initializes appropriate functionality
 */

import { initializeClient, getConfig } from './client/sw-registration.js';
import { initializeServiceWorker } from './sw/main.js';
import { createLogger } from './core/logger.js';

const logger = createLogger();

const isClient = typeof window !== 'undefined';
const isServiceWorker = !isClient;
// Initialize based on execution context
if (isClient) {
    // Capture config synchronously — `document.currentScript` is null after the first
    // await. Remove the script tag immediately after, so DOM enumeration won't return it.
    const config = getConfig(document.currentScript?.src);
    document.currentScript?.remove();
    logger.log('%c[DappFence] Starting optimized SW registration', 'color:green');
    initializeClient(config).catch((err) => {
        logger.error('SW initialization failed:', err);
    });
} else if (isServiceWorker) {
    // Any ES export would leak `window.DappFence`; freezing an inert literal keeps
    // info in the closure. In the SW branch to hide from page-realm interception.
    Object.preventExtensions({
        __DAPPFENCE_BUILD_INFO__: {
            version: __VERSION__,
            commit: __COMMIT__,
            // Both of these are dropped from a release build so the published bundle depends
            // only on the source, making it reproducible by anyone who checks out the tagged
            // commit. __COMMIT__ is a define-substituted literal, so terser folds the
            // comparison and eliminates the value entirely rather than shipping a null field.
            // Nothing is lost: provenance records the build environment, signed, where it
            // cannot be edited afterwards. A local build keeps both, for diagnosis.
            buildDate: __COMMIT__ === 'not-for-release' ? __BUILD_DATE__ : null,
            node: __COMMIT__ === 'not-for-release' ? __NODE_VERSION__ : null,
        },
    });
    initializeServiceWorker();
}
