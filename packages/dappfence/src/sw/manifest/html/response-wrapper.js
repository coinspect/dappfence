/**
 * Wraps a fetch Response to provide lazy, memoized body reading.
 * Exposes the properties needed by shouldSkipVerification and resolveManifestKey
 * without consuming the response body eagerly.
 *
 * getBodyBytes() → { value: Uint8Array } | { status: VERIFICATION_STATUS.ERROR }
 *
 * @param {Response} response
 */
import { VERIFICATION_STATUS } from '../../../core/constants.js';

export const makeResponseWrapper = (response) => {
    let bytesPromise = null;
    return {
        ok: response.ok,
        type: response.type,
        getBodyBytes() {
            if (!bytesPromise) {
                bytesPromise = response
                    .clone()
                    .arrayBuffer()
                    .then((buf) => ({ value: new Uint8Array(buf) }))
                    .catch(() => ({ status: VERIFICATION_STATUS.ERROR }));
            }
            return bytesPromise;
        },
    };
};
