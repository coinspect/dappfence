import { createLogger } from '../../core/logger.js';

const defaultLogger = createLogger();

/**
 * SW keepalive via waitUntil hopping.
 *
 * Minimal work-tracker: callers signal "I am working" via `hold()`, `run()`,
 * or `schedule()`. While any work is pending, each incoming event's
 * `waitUntil` slot is chained to a shared keepalive promise, and the previous
 * event's slot is resolved so the SW is released cleanly from older events.
 * When the counter hits zero, a short grace timer runs before the final
 * keepalive is resolved.
 *
 * No policy here (no debounce, no backoff, no priorities). Those live in the
 * consumers that call into the manager.
 */
export function createTaskManager({ graceMs = 3000, logger = defaultLogger } = {}) {
    let workCount = 0;
    let keepaliveResolve = null;
    let graceTimer = null;

    function cancelGrace() {
        if (graceTimer != null) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
    }

    function scheduleRelease() {
        cancelGrace();
        graceTimer = setTimeout(() => {
            graceTimer = null;
            if (keepaliveResolve) {
                keepaliveResolve();
            }
            keepaliveResolve = null;
            logger.log('[tm] keepalive released');
        }, graceMs);
    }

    function attach(event) {
        const hasWork = workCount > 0;
        const inGrace = graceTimer !== null;
        if (!hasWork && !inGrace) {
            logger.log('[tm] attach skipped: idle (no work, no grace)');
            return;
        }
        cancelGrace();
        const prevResolve = keepaliveResolve;
        const keepalivePromise = new Promise((r) => {
            keepaliveResolve = r;
        });
        event.waitUntil(keepalivePromise);
        if (prevResolve) {
            prevResolve();
        }
        if (!hasWork) {
            // In grace: restart the clock so this event's attach keeps the
            // keepalive alive for another graceMs instead of resolving stale.
            scheduleRelease();
        }
        logger.log(`[tm] attached; hopped=${!!prevResolve}, work=${workCount}, inGrace=${inGrace}`);
    }

    function hold() {
        workCount++;
        cancelGrace();
        let released = false;
        return {
            release() {
                if (released) {
                    logger.warn(`[tm] hold released more than once; ignoring`);
                    return;
                }
                released = true;
                workCount--;
                if (workCount === 0 && keepaliveResolve) {
                    scheduleRelease();
                }
            },
        };
    }

    async function run(fnOrPromise) {
        const h = hold();
        try {
            const value = typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise;
            return await value;
        } finally {
            h.release();
        }
    }

    return {
        attach,
        run,
    };
}
