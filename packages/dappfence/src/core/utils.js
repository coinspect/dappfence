/**
 * General-purpose utilities.
 */

/**
 * Check if a feature flag is enabled.
 * @param {string} feature - The feature name
 * @returns {boolean} true if the feature is enabled
 */
export function isFeatureEnabled(feature) {
    return __FEATURES__[feature] === true;
}

/**
 * Creates a single-flight wrapper: concurrent calls to the returned function
 * share one in-flight promise instead of starting duplicate work.
 * @returns {function} Wrapper that takes an async factory and deduplicates concurrent calls
 */
export function createSingleFlight() {
    let pending = null;
    return (fn) => {
        if (!pending) {
            pending = fn().finally(() => (pending = null));
        }
        return pending;
    };
}

/**
 * Wraps a zero-arg function so it runs on the first call and every subsequent
 * call returns the cached result — permanent cache for the wrapper's lifetime.
 * Works for sync and async; unlike createSingleFlight, the cached value is NOT
 * cleared on resolve.
 * @template T
 * @param {() => T} fn
 * @returns {() => T}
 */
export function once(fn) {
    let result;
    let called = false;
    return () => {
        if (!called) {
            result = fn();
            called = true;
        }
        return result;
    };
}

/**
 * Run an async function and swallow any throw, routing it to `onError` instead.
 * Used in SW event handlers that must not reject their waitUntil (which would
 * otherwise bubble to the browser's unhandled-error path).
 *
 * @param {() => Promise<unknown>} fn
 * @param {(error: unknown) => void} [onError]
 */
export async function safely(fn, onError) {
    try {
        await fn();
    } catch (error) {
        onError?.(error);
    }
}

export function hasConfigManifest(config) {
    return !!(
        config.manifestUrl &&
        config.manifestSignatureType &&
        config.manifestSignatureIdentity
    );
}
