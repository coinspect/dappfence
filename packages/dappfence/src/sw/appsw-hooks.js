/**
 * Service Worker Hooks Module
 * Installs monkey patches for importScripts and addEventListener
 */

import { monkeyPatch } from '../core/monkey-patch.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger();

// Keep track of registered listeners
const ListenerMap = () => {
    const data = new Map();
    const get = (eventType) => data.get(eventType) || [];
    const append = (eventType, handler) => {
        data.set(eventType, [...get(eventType), handler]);
    };

    return {
        get,
        append,
    };
};

/**
 * @param {function} onVerifyScript - Called with (scriptPath) to verify imported scripts
 * @param {object} [swScope=self] - The raw global scope for monkey-patching
 * @returns {{ installHooks: function, installEventDone: function, addEventListener: function, addDefaultEventListeners: function }}
 */
const createHookService = (onVerifyScript, swScope = self) => {
    // Monkey-patching targets the real global scope. swScope defaults to
    // `self` but can be replaced with a fake in tests.
    const listeners = ListenerMap();
    const eventListeners = new Set();
    let originalAddEventListener;
    let isInstallEventDone;
    const installEventDone = () => {
        isInstallEventDone = true;
    };
    /**
     * Install hooks to intercept service worker operations
     */
    const installHooks = () => {
        originalAddEventListener = swScope.addEventListener.bind(swScope);

        // Monkey patch importScripts to verify all loaded scripts
        if (typeof importScripts !== 'undefined') {
            monkeyPatch(swScope, 'importScripts', (ctx, ...scriptPaths) => {
                logger.log('importScripts called with:', scriptPaths);
                if (isInstallEventDone) {
                    logger.error('importScripts called after install event !!!!', scriptPaths);
                }
                // Verify all imported scripts (fire-and-forget, importScripts is synchronous)
                Promise.all(
                    scriptPaths.map((scriptPath) =>
                        onVerifyScript(scriptPath).catch((error) =>
                            logger.error(`Script verification failed for ${scriptPath}:`, error)
                        )
                    )
                ).then(() => logger.log('All importScripts verifications completed'));

                // Load the scripts using the original function
                return ctx.call(...scriptPaths);
            });
        }

        // Monkey patch addEventListener to maintain our `fetch` handler at the end of the chain
        // TODO: check if we must support the rest of the addEventListener arguments (options, etc)
        monkeyPatch(swScope, 'addEventListener', (ctx, type, listener) => {
            logger.log('addEventListener:', type);
            if (!eventListeners.has(type)) {
                logger.error(`Warning: Event type '${type}' is not registered`);
            }
            // Inside the 'install' event handler, we call importScripts to load additional scripts.
            // To ensure proper scoping, addEventListener calls from imported scripts are tracked in our listener Map
            // rather than being directly registered. This allows us to maintain proper control over the event handling chain.
            const boundListener = listener.bind(swScope);
            listeners.append(type, boundListener);
        });

        // Return the stored listeners for fetch handling
        return listeners;
    };

    const addEventListener = (eventType, handler) => {
        if (!originalAddEventListener) {
            throw new Error('[DappFence SW] Error Service Worker hooks not installed');
        }
        // keep track of the events we listen for
        eventListeners.add(eventType);
        const callChildHandlers = (event) => {
            for (const l of listeners.get(eventType)) {
                try {
                    l.call(swScope, event);
                } catch (error) {
                    logger.error(`Error in fetch listener ${eventType}`, error);
                }
            }
        };
        originalAddEventListener(eventType, (event) => {
            handler(event, callChildHandlers);
        });
    };
    const addDefaultEventListeners = () => {
        const eventTypes = [
            'backgroundfetchabort',
            'backgroundfetchclick',
            'backgroundfetchfail',
            'backgroundfetchsuccess',
            'canmakepayment',
            'contentdelete',
            'cookiechange',
            'messageerror',
            'notificationclick',
            'notificationclose',
            'paymentrequest',
            'periodicsync',
            'push',
            'pushsubscriptionchange',
            'sync',
        ];
        for (const eventType of eventTypes) {
            addEventListener(eventType, (event, callChildHandlers) => {
                logger.log(`event type ${eventType} received:`, event);
                callChildHandlers(event);
            });
        }
    };
    // Return the service interface
    return {
        installEventDone,
        installHooks,
        addEventListener,
        addDefaultEventListeners,
    };
};
export { createHookService };
