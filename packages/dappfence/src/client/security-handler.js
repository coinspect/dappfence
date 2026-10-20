import { createLogger } from '../core/logger.js';
import { MSG } from '../core/constants.js';

const logger = createLogger();

export function setupSecurityMessageListener() {
    navigator.serviceWorker.addEventListener('message', handleSecurityMessage);
    logger.log('Security message listener installed');
}

let redirectAttempted = false;
/**
 * Handle security messages from a service worker.
 *
 * Uses `location.replace` (not `location.href`) so the blocked URL is NOT
 * added to history — pressing Back after dismissing the warning should not
 * return the user to the tampered page.
 */
function handleSecurityMessage(event) {
    const { data } = event;
    if (data?.type !== MSG.SECURITY_BLOCK || redirectAttempted) {
        return;
    }
    logger.error('Security violation detected');
    redirectAttempted = true;
    window.location.replace(data.warningUrl);
}

/**
 * Notify a service worker that the client is ready to receive security messages
 */
export function notifyServiceWorkerReady() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
        logger.warn('No SW controller available to notify of client ready');
        return;
    }

    navigator.serviceWorker.controller.postMessage({
        type: MSG.CLIENT_READY,
        timestamp: Date.now(),
    });
    logger.log('Notified SW that client is ready for security messages');
}

/**
 * Periodically ask the SW to drain its telemetry queue. Timers on the client
 * page survive while the tab is open — gives us a drain path that doesn't
 * depend on fetch traffic or Background Sync.
 */
export function startReportEventsPing(intervalMs = __DEV__ ? 15_000 : 300_000) {
    setInterval(() => {
        const controller = navigator.serviceWorker?.controller;
        if (!controller) {
            return;
        }
        controller.postMessage({ type: MSG.REPORT_EVENTS, timestamp: Date.now() });
    }, intervalMs);
    logger.log(`Report-events ping scheduled every ${intervalMs}ms`);
}

/**
 * Notify the SW that this page finished loading. One-shot per page.
 * Settle delay catches late async scripts in performance.getEntries().
 * Payload is minimal in PR1 — scriptSrcs / inlineHashes land in PR2.
 */
export function notifyPageLoaded(settleMs = 1500) {
    const fire = () => {
        setTimeout(() => {
            const controller = navigator.serviceWorker?.controller;
            if (!controller) {
                logger.warn('No SW controller available to notify of page loaded');
                return;
            }
            controller.postMessage({
                type: MSG.PAGE_LOADED,
                pageUrl: location.href,
                timestamp: Date.now(),
            });
            logger.log('Notified SW that page is loaded');
        }, settleMs);
    };
    if (document.readyState === 'complete') {
        fire();
    } else {
        window.addEventListener('load', fire, { once: true });
    }
}
