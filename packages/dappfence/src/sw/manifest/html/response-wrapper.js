/**
 * Wraps a fetch Response to provide lazy, memoized body reading and hashing.
 * Exposes the properties needed by shouldSkipVerification and resolveManifestKey
 * without consuming the response body eagerly.
 *
 * getBodyBytes()      → { value: Uint8Array } | { status: VERIFICATION_STATUS.ERROR, reason: 'BODY_UNREADABLE' }
 * calculateBodyHash() → { value: string }     | { status: VERIFICATION_STATUS.ERROR, reason: 'BODY_UNREADABLE' }
 *
 * Both results are memoized for the ret's lifetime so manifest escalation
 * (which may re-verify the same body against several manifests) hashes once.
 *
 * @param {Response} response
 */
import { VERIFICATION_STATUS } from '../../../core/constants.js';
import { calculateHash } from '../../../core/crypto.js';
import { once } from '../../../core/utils.js';

export const makeResponseWrapper = (response) => {
    const ret = {
        ok: response.ok,
        status: response.status,
        type: response.type,
        headers: response.headers,
        getBodyBytes: once(async () => {
            try {
                const buf = await response.clone().arrayBuffer();
                return { value: new Uint8Array(buf) };
            } catch {
                return {
                    status: VERIFICATION_STATUS.ERROR,
                    reason: 'BODY_UNREADABLE',
                };
            }
        }),
        calculateBodyHash: once(async () => {
            const bytes = await ret.getBodyBytes();
            if (bytes.status) {
                return bytes;
            }
            const value = await calculateHash(bytes.value);
            return { value };
        }),
    };
    return ret;
};
