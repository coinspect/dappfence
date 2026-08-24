/**
 * General-purpose utilities.
 */

/**
 * Assert a condition during development. No-op in production (dead code eliminated by Terser).
 * @param {*} condition
 */
export function devAssert(condition) {
    if (__DEV__) {
        if (!condition) throw new Error('devAssert failed');
    }
}

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

export function hasConfigManifest(config) {
    return !!(
        config.manifestUrl &&
        config.manifestSignatureType &&
        config.manifestSignatureIdentity
    );
}
