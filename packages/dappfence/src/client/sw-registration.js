/**
 * DappFence Secure Service Worker Client
 * Implements Immediate Protection and Controlled App SW Integration
 */
import { createLogger } from '../core/logger.js';
import { monkeyPatch, secureMonkeyPatch, verifyPatchIntegrity } from '../core/monkey-patch.js';
import { notifyServiceWorkerReady, setupSecurityMessageListener } from './security-handler.js';
import { hasConfigManifest } from '../core/utils.js';
import { MSG } from '../core/constants.js';
import { createEmergencyPanel } from '../core/emergency-panel.js';

const logger = createLogger();

let controllerClaimed = false;
let queuedAppSWArgs = null;
let queuedAppSWResolve = null;
let isReplacingSW = false;
let originalRegister = null;

// Anti-tampering: Track secure patches
const securePatches = [];
let integrityCheckInterval = null;

/**
 * Get configuration from current script data attributes or global window config.
 */
function getConfig(clientScriptUrl) {
    let config = {
        manifestUrl: null,
        manifestSignatureType: null,
        manifestSignatureIdentity: null,
        appSW: null,
        blockingEnabled: true,
        securityMessage: 'Security verification failed. This content has been modified.',
        contactInfo: null,
        baseUrl: clientScriptUrl,
    };

    // Try to get config from global window object first
    if (typeof window !== 'undefined' && window.DappFenceConfig) {
        config = { ...config, ...window.DappFenceConfig };
        console.log('[DappFence Config] Loaded from window.DappFenceConfig:', config);
    } else if (typeof document !== 'undefined') {
        // Try to get config from the current script or fallback element
        const script = document.currentScript || document.getElementById('dappfence-config');
        if (script) {
            config.manifestUrl = script.getAttribute('data-manifest');
            config.appSW = script.getAttribute('data-app-sw');
            config.manifestSignatureType = script.getAttribute('data-manifest-signature-type');
            config.manifestSignatureIdentity = script.getAttribute(
                'data-manifest-signature-identity'
            );
            config.blockingEnabled = script.getAttribute('data-blocking-enabled') !== 'false';
            config.securityMessage = script.getAttribute('data-security-message');
            config.contactInfo = script.getAttribute('data-contact-info');
            config.baseUrl = script.getAttribute('data-base-url') ?? config.baseUrl;
            console.log('[DappFence Config] Loaded from script data attributes:', config);
        }
    }

    // Precedence: explicit override (window/data-base-url) → currentScript.src → default.
    // Needed because `document.currentScript` is null for `type="module"` scripts.
    config.baseUrl = new URL(config.baseUrl ?? '/dappfence.js', location.origin);
    if (config.baseUrl.pathname.lastIndexOf('/') !== 0) {
        console.warn(
            `[DappFence] not at site root (${config.baseUrl.pathname}) — SW scope limited`
        );
    }
    return config;
}

function buildSwUrl(cfg, appSW = null) {
    const url = new URL(cfg.baseUrl, window.location.origin);
    if (appSW) {
        url.searchParams.set('appSW', appSW);
    } else if (cfg.appSW) {
        url.searchParams.set('appSW', cfg.appSW);
    } else if (navigator.serviceWorker.controller) {
        // We already auto-detected appSW, just add it to avoid loading the SW twice.
        const swUrl = new URL(navigator.serviceWorker.controller.scriptURL);
        const currentAppSW = swUrl.searchParams.get('appSW');
        if (currentAppSW) {
            url.searchParams.set('appSW', currentAppSW);
        }
    }
    if (hasConfigManifest(cfg)) {
        url.searchParams.set('manifestUrl', cfg.manifestUrl);
        url.searchParams.set('manifestSignatureType', cfg.manifestSignatureType);
        url.searchParams.set('manifestSignatureIdentity', cfg.manifestSignatureIdentity);
    }
    // Optional config hash to prevent redundant SW reloads
    url.searchParams.set('cfgHash', hashConfig(cfg));
    return url.href;
}

function hashConfig(config) {
    // Very simple hash to avoid re-registering the same config
    return btoa(JSON.stringify(config)).slice(0, 16);
}

async function waitForControllerClaim(timeout = 2000) {
    return new Promise((resolve) => {
        if (navigator.serviceWorker.controller) {
            controllerClaimed = true;
            logger.log('Page already controlled by SW');
            return resolve();
        }

        logger.log('Page not controlled - waiting for SW to claim control');

        const timer = setTimeout(() => {
            logger.warn('Controller claim timed out');
            resolve();
        }, timeout);

        navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
                clearTimeout(timer);
                controllerClaimed = true;
                logger.log('Controller claimed successfully');
                resolve();
            },
            { once: true }
        );

        // Only request claim if the page is not controlled (shift+reload, first load, etc.)
        navigator.serviceWorker
            .getRegistration()
            .then((registration) => {
                if (registration && registration.active) {
                    logger.log('🔄 Requesting SW to claim control (likely shift+reload)');
                    registration.active.postMessage({
                        type: MSG.CLAIM_CONTROL,
                        timestamp: Date.now(),
                    });
                } else {
                    logger.log('No active SW found to request claim from');
                }
            })
            .catch((err) => {
                logger.warn('Failed to request SW claim:', err);
            });
    });
}

async function attemptEarlyControlClaim() {
    try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration && registration.active) {
            // If already controlled, mark as claimed
            if (navigator.serviceWorker.controller) {
                controllerClaimed = true;
                logger.log('Page already controlled by SW');
            } else {
                logger.log('🔄 Sending claim to existing SW');
                // Note: Alternatively, could trigger a soft reload with `window.location.reload()` to ensure immediate control
                registration.active.postMessage({
                    type: MSG.CLAIM_CONTROL,
                    timestamp: Date.now(),
                });
            }
        } else {
            logger.log('No existing active SW found');
        }
    } catch (err) {
        logger.warn('Failed to attempt early control claim:', err);
    }
}

async function registerCombinedSW(appSwUrl, config) {
    if (isReplacingSW) {
        return;
    }
    isReplacingSW = true;

    const combinedUrl = buildSwUrl(config, appSwUrl);
    logger.log('Registering combined DappFence+App SW:', combinedUrl);

    try {
        const reg = await originalRegister(combinedUrl, { updateViaCache: 'all' });
        logger.log('Combined SW registered');
        return reg;
    } catch (e) {
        logger.error('Failed to register combined SW:', e);
        throw e;
    }
}

async function installClientHooks(config) {
    logger.log('%c[DappFence Client] Installing secure anti-tampering patches', 'color:green');

    if (navigator.__dappfencePatched) {
        logger.log('Already patched, verifying integrity...');
        const results = verifyPatchIntegrity(securePatches);
        if (!results.allIntact) {
            logger.error('🚨 TAMPERING DETECTED! Some patches have been compromised.');
        }
        return;
    }
    navigator.__dappfencePatched = true;

    // Apply SECURE monkey patch that cannot be easily removed
    const registerPatch = secureMonkeyPatch(
        navigator.serviceWorker,
        'register',
        async (ctx, swUrl, options) => {
            logger.log('App SW registration attempt intercepted:', swUrl);

            if (!controllerClaimed) {
                logger.log('Deferring App SW registration until DappFence SW claims control');
                // Queue the call and return Promise
                queuedAppSWArgs = [swUrl, options];
                return new Promise((resolve) => {
                    queuedAppSWResolve = resolve;
                });
            }

            // Already in control — register integrated SW now
            return await registerCombinedSW(swUrl, config);
        }
    );

    if (registerPatch.success) {
        securePatches.push(registerPatch);
        logger.log('🔒 Secure patch applied successfully');

        // Start periodic integrity verification
        startIntegrityMonitoring();
    } else {
        logger.error('Failed to apply secure patch:', registerPatch.error);
        // Fallback to a regular patch
        monkeyPatch(navigator.serviceWorker, 'register', async (ctx, swUrl, options) => {
            // Same handler logic as above
            logger.log('App SW registration attempt intercepted (fallback):', swUrl);
            if (!controllerClaimed) {
                queuedAppSWArgs = [swUrl, options];
                return new Promise((resolve) => {
                    queuedAppSWResolve = resolve;
                });
            }
            return await registerCombinedSW(swUrl, config);
        });
    }
}

/**
 * Start periodic integrity monitoring to detect tampering attempts
 */
function startIntegrityMonitoring() {
    if (integrityCheckInterval) {
        return; // Already running
    }

    integrityCheckInterval = setInterval(() => {
        const results = verifyPatchIntegrity(securePatches);
        if (!results.allIntact) {
            logger.error('🚨 CRITICAL: Patch tampering detected!', results);
            // TODO: Implement breach response (full-site blocking, etc.)
        }
    }, 5000); // Check every 5 seconds

    logger.log('🔒 Integrity monitoring started (5-second intervals)');
}

export async function initializeClient(clientScriptUrl) {
    const config = getConfig(clientScriptUrl);
    logger.log('Client initializing with config:', config);

    if (!('serviceWorker' in navigator)) {
        logger.log('Client initialization failed, service worker not supported');
        return;
    }

    // Store the original register function BEFORE monkey patching
    originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);

    // Monkey patch SW register early
    await installClientHooks(config);

    // Set up a security message listener for intercepting violations early, even before SW claims control
    setupSecurityMessageListener();

    // PHASE 0: Check for existing SW and claim control immediately if found
    await attemptEarlyControlClaim();

    // PHASE 1: Register Standalone SW (only if no existing compatible SW)
    const standaloneUrl = buildSwUrl(config, null);
    logger.log('Registering standalone SW:', standaloneUrl);

    try {
        await originalRegister(standaloneUrl, { updateViaCache: 'all' });
    } catch (err) {
        logger.log('Standalone SW registration failed:', err);
    }

    const request = indexedDB.open('AppSecurityWatchdog', 1);
    request.onerror = () => console.error(request.error);
    request.onsuccess = (event) => {
        const db = event.target.result;
        db.onclose = () => {
            logger.warn('Watchdog database closed, EMERGENCY!!!');
            // Re-registering may fail if the SW scope is already taken, but we still
            // display the emergency panel to protect the user.
            originalRegister(standaloneUrl, { updateViaCache: 'all' }).catch((err) =>
                logger.error('Error trying to register dappfence during an EMERGENCY', err)
            );
            document.documentElement.innerHTML = createEmergencyPanel();
        };
    };
    // PHASE 2: Wait until SW claims control (or is already controlled)
    await waitForControllerClaim();

    // PHASE 3: Process queued app SW registration
    if (queuedAppSWArgs && queuedAppSWResolve) {
        const [appSwUrl] = queuedAppSWArgs;
        try {
            const reg = await registerCombinedSW(appSwUrl, config);
            queuedAppSWResolve(reg);
        } catch (err) {
            logger.log('Failed to process queued app SW:', err);
            queuedAppSWResolve(null);
        }
        queuedAppSWArgs = null;
        queuedAppSWResolve = null;
    }

    // Notify a service worker that the client is fully ready
    notifyServiceWorkerReady();

    logger.log('%c[DappFence] Initialization complete and protection active.', 'color:green');
}
