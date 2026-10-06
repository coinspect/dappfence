/**
 * Leaf-level tests for basicVerifyAgainstManifest — hash-compare only, no
 * action pipeline, no CSP. Factory-level behavior (pinning, escalation, gate
 * checks) is tested in verifier.test.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { basicVerifyAgainstManifest } from '../manifest/security-verifier.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const FILE_HASH = 'sha256-abc123';
const LOCATION_HREF = 'https://example.com/sw.js';

const MANIFEST_INFO = {
    appVersion: 'v1',
    manifest: {
        files: { '/index.html': [FILE_HASH] },
        pathRules: [{ type: 'directory-index' }],
        mode: 'protected',
    },
};

vi.mock('../../core/crypto.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateHash: vi.fn(() => Promise.resolve(FILE_HASH)) };
});
import { calculateHash } from '../../core/crypto.js';

beforeEach(() => {
    calculateHash.mockReset();
    calculateHash.mockResolvedValue(FILE_HASH);
});

function makeReq(path = '/index.html') {
    return {
        method: 'GET',
        mode: 'same-origin',
        destination: 'script',
        url: `https://example.com${path}`,
    };
}

function makeResponse(bytes = new Uint8Array([1, 2, 3])) {
    return {
        getBodyBytes: vi.fn(() => Promise.resolve({ value: bytes })),
    };
}

describe('basicVerifyAgainstManifest', () => {
    it('returns MATCH when actual hash is in the manifest files map', async () => {
        const result = await basicVerifyAgainstManifest(
            makeReq('/index.html'),
            makeResponse(),
            MANIFEST_INFO,
            LOCATION_HREF
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.actualHash).toBe(FILE_HASH);
        expect(result.expectedHashes).toEqual([FILE_HASH]);
        expect(result.fileKey).toBe('/index.html');
    });

    it('returns MISMATCH when the hash differs from the manifest', async () => {
        calculateHash.mockResolvedValueOnce('sha256-tampered');
        const result = await basicVerifyAgainstManifest(
            makeReq('/index.html'),
            makeResponse(),
            MANIFEST_INFO,
            LOCATION_HREF
        );
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.actualHash).toBe('sha256-tampered');
        expect(result.expectedHashes).toEqual([FILE_HASH]);
    });

    it('returns NOT_FOUND_IN_MANIFEST when the fileKey is unknown', async () => {
        const result = await basicVerifyAgainstManifest(
            makeReq('/unknown.js'),
            makeResponse(),
            MANIFEST_INFO,
            LOCATION_HREF
        );
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
        expect(result.actualHash).toBe(FILE_HASH);
    });

    it('propagates body-read errors as the error status', async () => {
        const response = {
            getBodyBytes: vi.fn(() => Promise.resolve({ status: VERIFICATION_STATUS.ERROR })),
        };
        const result = await basicVerifyAgainstManifest(
            makeReq('/index.html'),
            response,
            MANIFEST_INFO,
            LOCATION_HREF
        );
        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });
});
