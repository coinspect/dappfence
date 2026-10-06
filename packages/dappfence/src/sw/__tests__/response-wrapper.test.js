/**
 * Unit tests for makeResponseWrapper — covers the lazy body-bytes memoization
 * and the cached calculateBodyHash() helper used by both verifier strategies to
 * avoid re-hashing the same body across manifest-escalation attempts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeResponseWrapper } from '../manifest/html/response-wrapper.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const BODY_HASH = 'sha256-body';

vi.mock('../../core/crypto.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateHash: vi.fn(() => Promise.resolve(BODY_HASH)) };
});
import { calculateHash } from '../../core/crypto.js';

beforeEach(() => {
    calculateHash.mockReset();
    calculateHash.mockResolvedValue(BODY_HASH);
});

function makeResponse(bytes = new Uint8Array([1, 2, 3])) {
    const r = {
        ok: true,
        status: 200,
        type: 'basic',
        headers: new Headers(),
        arrayBuffer: vi.fn(() => Promise.resolve(bytes.buffer)),
    };
    r.clone = vi.fn(() => ({ arrayBuffer: r.arrayBuffer }));
    return r;
}

describe('makeResponseWrapper — getBodyBytes', () => {
    it('returns the body bytes as a Uint8Array on first call', async () => {
        const wrapper = makeResponseWrapper(makeResponse(new Uint8Array([9, 9, 9])));
        const result = await wrapper.getBodyBytes();
        expect(result.value).toEqual(new Uint8Array([9, 9, 9]));
    });

    it('memoizes bytes across repeated calls (clone/arrayBuffer runs once)', async () => {
        const response = makeResponse();
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyBytes();
        await wrapper.getBodyBytes();
        expect(response.clone).toHaveBeenCalledTimes(1);
        expect(response.arrayBuffer).toHaveBeenCalledTimes(1);
    });

    it('returns an ERROR status when the body cannot be read', async () => {
        const response = makeResponse();
        response.clone = vi.fn(() => ({
            arrayBuffer: vi.fn(() => Promise.reject(new Error('boom'))),
        }));
        const wrapper = makeResponseWrapper(response);
        const result = await wrapper.getBodyBytes();
        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });
});

describe('makeResponseWrapper — calculateBodyHash', () => {
    it('returns the hash of the body on first call', async () => {
        const wrapper = makeResponseWrapper(makeResponse());
        const result = await wrapper.calculateBodyHash();
        expect(result.value).toBe(BODY_HASH);
        expect(calculateHash).toHaveBeenCalledTimes(1);
    });

    it('caches the hash across repeated calls (calculateHash runs once)', async () => {
        const wrapper = makeResponseWrapper(makeResponse());
        await wrapper.calculateBodyHash();
        await wrapper.calculateBodyHash();
        await wrapper.calculateBodyHash();
        expect(calculateHash).toHaveBeenCalledTimes(1);
    });

    it('propagates body-read errors without invoking calculateHash', async () => {
        const response = makeResponse();
        response.clone = vi.fn(() => ({
            arrayBuffer: vi.fn(() => Promise.reject(new Error('boom'))),
        }));
        const wrapper = makeResponseWrapper(response);
        const result = await wrapper.calculateBodyHash();
        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
        expect(calculateHash).not.toHaveBeenCalled();
    });

    it('shares the memoized bytes with getBodyBytes', async () => {
        const response = makeResponse();
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyBytes();
        await wrapper.calculateBodyHash();
        expect(response.clone).toHaveBeenCalledTimes(1);
        expect(response.arrayBuffer).toHaveBeenCalledTimes(1);
    });
});
