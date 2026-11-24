/**
 * Deterministic PRNG-backed response bodies for OOM tests.
 *
 * The goal: stream a response of arbitrary size (hundreds of MB to several GB)
 * from a seeded PRNG so neither the server nor the test harness needs to hold
 * the body in memory. Because the PRNG is seeded, the SHA-256 of the body is a
 * pure function of `(seed, sizeBytes)` and can be precomputed or cached.
 *
 * The emitted body wraps hex PRNG output as a valid JS statement so a `<script>`
 * tag referencing it will reach the parse step after the SRI / SW hash passes.
 * Hex (`0-9a-f`) is safe inside any JS string / HTML text — never contains `"`,
 * `\`, `</script>`, or comment terminators.
 */

import crypto from 'node:crypto';

const PREFIX = 'const _ = "';
const SUFFIX = '";void _;';
const WRAPPER_LEN = PREFIX.length + SUFFIX.length;

// Write the hex payload in ~64 KB chunks. Small enough to keep flow-control
// responsive, big enough to amortize per-write overhead on multi-GB bodies.
const CHUNK_CHARS = 64 * 1024;

/**
 * xorshift32 — tiny deterministic PRNG. One 32-bit state, period ~2^32.
 * Not cryptographically secure; we only need reproducibility.
 *
 * @param {number} seed - 32-bit seed; 0 is rewritten to 1 (xorshift stays stuck at 0)
 * @returns {() => number} next() returning an unsigned 32-bit value
 */
export function xorshift32(seed) {
    let state = seed | 0 || 1;
    return function next() {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * Yield hex payload chunks (no wrapper). Each value's 8 hex chars come from
 * one 32-bit PRNG word. The final chunk is trimmed to land exactly on
 * `hexCharCount` total output chars.
 *
 * @param {number} seed
 * @param {number} hexCharCount - exact number of hex chars to emit
 * @yields {string}
 */
export function* hexChunks(seed, hexCharCount) {
    const next = xorshift32(seed);
    let written = 0;

    while (written < hexCharCount) {
        const remain = hexCharCount - written;
        const take = Math.min(CHUNK_CHARS, remain);
        let chunk = '';
        // One 32-bit word = 8 hex chars. Overshoot by up to 7 then slice.
        while (chunk.length < take) {
            chunk += next().toString(16).padStart(8, '0');
        }
        if (chunk.length > take) {
            chunk = chunk.slice(0, take);
        }
        written += chunk.length;
        yield chunk;
    }
}

/**
 * Stream the wrapped payload (PREFIX + hex + SUFFIX) into a Node writable.
 * Respects backpressure via the `drain` event. Resolves after the last chunk
 * is written (caller is responsible for `res.end()`).
 *
 * @param {NodeJS.WritableStream} out
 * @param {number} totalBytes - exact body size (must be >= WRAPPER_LEN)
 * @param {number} seed
 * @returns {Promise<void>}
 */
export function streamPayload(out, totalBytes, seed) {
    if (totalBytes < WRAPPER_LEN) {
        return Promise.reject(
            new Error(`totalBytes must be >= ${WRAPPER_LEN} to fit the JS wrapper`)
        );
    }
    const hexCharCount = totalBytes - WRAPPER_LEN;

    return new Promise((resolve, reject) => {
        const iter = hexChunks(seed, hexCharCount);
        let phase = 'prefix';

        function pump() {
            if (phase === 'prefix') {
                phase = 'hex';
                if (!out.write(PREFIX)) {
                    out.once('drain', pump);
                    return;
                }
            }
            if (phase === 'hex') {
                while (true) {
                    const { value, done } = iter.next();
                    if (done) {
                        phase = 'suffix';
                        break;
                    }
                    if (!out.write(value)) {
                        out.once('drain', pump);
                        return;
                    }
                }
            }
            if (phase === 'suffix') {
                phase = 'done';
                if (!out.write(SUFFIX)) {
                    out.once('drain', () => resolve());
                    return;
                }
            }
            resolve();
        }

        out.on('error', reject);
        pump();
    });
}

// (seed, totalBytes) → "sha256-…". Hashing a multi-GB body costs ~tens of
// seconds of CPU; a dev running the same OOM test repeatedly would pay that
// cost on every request without this. Memoized for the lifetime of the
// process. Key is small enough that no eviction is needed in practice.
const hashCache = new Map();

/**
 * Compute (or retrieve from cache) the SHA-256 of the wrapped payload for a
 * given (seed, totalBytes). Streams through the hash — never materializes
 * the body.
 *
 * @param {number} seed
 * @param {number} totalBytes
 * @returns {string} SRI-style "sha256-<base64>"
 */
export function computeHash(seed, totalBytes) {
    if (totalBytes < WRAPPER_LEN) {
        throw new Error(`totalBytes must be >= ${WRAPPER_LEN}`);
    }
    const key = `${seed}:${totalBytes}`;
    const cached = hashCache.get(key);
    if (cached) {
        return cached;
    }

    const h = crypto.createHash('sha256');
    h.update(PREFIX);
    for (const chunk of hexChunks(seed, totalBytes - WRAPPER_LEN)) {
        h.update(chunk);
    }
    h.update(SUFFIX);
    const digest = 'sha256-' + h.digest('base64');

    hashCache.set(key, digest);
    return digest;
}

/**
 * Compute the hash for the inline-script body used by the CSP test page.
 * The inline content is exactly the same wrapper used by `/huge/bytes` so a
 * single fixture entry works for both SRI and CSP variants.
 *
 * @param {number} seed
 * @param {number} totalBytes
 * @returns {string} "sha256-<base64>" (what goes into the CSP header)
 */
export function cspHashFor(seed, totalBytes) {
    return computeHash(seed, totalBytes);
}

export const PAYLOAD_PREFIX = PREFIX;
export const PAYLOAD_SUFFIX = SUFFIX;
export const PAYLOAD_WRAPPER_LEN = WRAPPER_LEN;
