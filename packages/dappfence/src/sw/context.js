/**
 * Service Worker Context
 *
 * Wraps all access to the service worker global scope (`self`) and owns the
 * response-body-read boundary. Every property is a function so the underlying
 * value is read on each call, making it easy to swap or mock in tests.
 *
 * In production, createSwContext() captures the real `self`.
 * In tests, provide a mock object to avoid needing a browser environment.
 */

import { calculateHash } from '../core/crypto.js';

/** Thrown when a bounded body read exceeds the per-call `maxBytes` cap. */
export class BodyTooLargeError extends Error {
    constructor(maxBytes) {
        super(`body exceeded ${maxBytes} bytes`);
        this.name = 'BodyTooLargeError';
    }
}

/**
 * Drain `response.body` into a single Uint8Array, bounded by `maxBytes`.
 * Cancels the stream and throws `BodyTooLargeError` if exceeded.
 * @param {Response} response - a cloned response; the stream will be consumed.
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 */
async function bufferResponseBytes(response, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new TypeError(
            `bufferResponseBytes: maxBytes must be a positive finite number, got ${maxBytes}`
        );
    }
    if (!response.body) {
        return new Uint8Array(0);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new BodyTooLargeError(maxBytes);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * Lazy memoized wrapper around a Response. The wrapper drains a clone of the
 * body, so the original `response` stays untouched for `unwrap()` — which is
 * what you hand to `event.respondWith`.
 *
 * Mirrors the native Response surface for body reads (`.text()` / `.json()` /
 * `.arrayBuffer()` return the parsed value and throw on error), with the
 * addition of a `maxBytes` cap at each read site. Reads are memoized — the
 * first call buffers; subsequent calls reuse the cached bytes. Hashing is
 * similarly cached across repeated `.calculateBodyHash()` calls (useful during
 * manifest escalation where the same body is checked against several
 * manifests).
 *
 * Throws `BodyTooLargeError` when a read exceeds its cap; any other failure
 * (network, abort, JSON parse) propagates as the native error.
 *
 * @param {Response} response
 */
const wrapResponse = (response) => {
    let cachedBytes;
    let cachedHash;

    /** @param {number} maxBytes */
    const bytes = async (maxBytes) => {
        if (!cachedBytes) {
            cachedBytes = await bufferResponseBytes(response.clone(), maxBytes);
        }
        return cachedBytes;
    };

    return {
        ok: response.ok,
        status: response.status,
        type: response.type,
        url: response.url,
        redirected: response.redirected,
        headers: response.headers,

        bytes,

        /** @param {number} maxBytes @returns {Promise<string>} */
        async text(maxBytes) {
            return new TextDecoder().decode(await bytes(maxBytes));
        },

        /** @param {number} maxBytes @returns {Promise<unknown>} */
        async json(maxBytes) {
            return JSON.parse(await this.text(maxBytes));
        },

        /** @param {number} maxBytes @returns {Promise<ArrayBuffer>} */
        async arrayBuffer(maxBytes) {
            const b = await bytes(maxBytes);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },

        /** @param {number} maxBytes @returns {Promise<string>} */
        async calculateBodyHash(maxBytes) {
            if (!cachedHash) {
                cachedHash = await calculateHash(await bytes(maxBytes));
            }
            return cachedHash;
        },

        /** Original response, body stream untouched — pass to event.respondWith. */
        unwrap: () => response,
    };
};

/**
 * @param {object} [swGlobal=self] - The service worker global scope
 */
export function createSwContext(swGlobal = self) {
    return {
        // Location
        getLocationHref: () => swGlobal.location.href,
        getLocationOrigin: () => swGlobal.location.origin,
        getLocation: () => swGlobal.location,

        // Clients API
        matchAllClients: (opts) => swGlobal.clients.matchAll(opts),
        getClient: (id) => swGlobal.clients.get(id),
        claimClients: () => swGlobal.clients.claim(),

        // Lifecycle
        skipWaiting: () => swGlobal.skipWaiting(),

        // Environment
        getUserAgent: () => swGlobal.navigator.userAgent,

        // `fetchWrapped` returns WrappedResponse; use `.unwrap()` for respondWith.
        // `wrapResponse` is for Responses produced elsewhere (e.g. app SW handler).
        fetchWrapped: async (input, init) => wrapResponse(await swGlobal.fetch(input, init)),
        wrapResponse,
    };
}
