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
        // Only values derived from the source. A build timestamp and the builder's Node
        // version used to live here too; they made the bundle depend on the machine that
        // produced it, so the same commit could not be rebuilt byte-for-byte by anyone else.
        // Nothing is lost -- `commit` already determines them, via .nvmrc at that commit and
        // the commit's own date, and provenance records the build environment signed.
        __DAPPFENCE_BUILD_INFO__: {
            version: __VERSION__,
            commit: __COMMIT__,
        },
    });
    initializeServiceWorker();
}
