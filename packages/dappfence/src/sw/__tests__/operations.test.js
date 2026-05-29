import { describe, it, expect, beforeAll } from 'vitest';
import {
    verifyFilePath,
    normalizeManifestData,
    getFileKey,
    verifyManifestSignature,
    shouldVerifyAsset,
} from '../manifest/operations.js';
import { createSingleFlight } from '../../core/utils.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';
import { sign, etc, hashes, recoverPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ethereumAddress } from '../../core/crypto.js';

beforeAll(() => {
    hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
    hashes.sha256 = sha256;
});

describe('verifyFilePath', () => {
    const manifest = {
        files: {
            '/app.js': 'abc123',
            '/style.css': 'def456',
            '/index.html': 'idx111',
            '/docs/index.html': 'idx222',
        },
    };

    it('returns MATCH when fileKey is registered and the hash matches', () => {
        const result = verifyFilePath(manifest, '/app.js', 'abc123', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/app.js');
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('abc123');
    });

    it('returns MISMATCH when fileKey is registered but hash differs', () => {
        const result = verifyFilePath(manifest, '/app.js', 'wrong', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('wrong');
    });

    it('returns NOT_FOUND_IN_MANIFEST for an unregistered fileKey', () => {
        const result = verifyFilePath(manifest, '/unknown.js', 'def456', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
        expect(result.expectedHash).toBeUndefined();
    });

    it('does not match by hash value alone (content under a different key is NOT_FOUND)', () => {
        const result = verifyFilePath(manifest, '/any-path', 'def456', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('navigation: remaps "/" to "/index.html"', () => {
        const result = verifyFilePath(manifest, '/', 'idx111', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/index.html');
        expect(result.expectedHash).toBe('idx111');
    });

    it('navigation: remaps "/docs/" to "/docs/index.html"', () => {
        const result = verifyFilePath(manifest, '/docs/', 'idx222', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/docs/index.html');
    });

    it('navigation: remaps extensionless "/docs" to "/docs/index.html"', () => {
        const result = verifyFilePath(manifest, '/docs', 'idx222', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/docs/index.html');
    });

    it('non-navigation: does not remap "/"', () => {
        const result = verifyFilePath(manifest, '/', 'idx111', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('line 36: navigation with no index.html in manifest returns NOT_FOUND_IN_MANIFEST', () => {
        const noIndexManifest = { files: { '/app.js': 'abc123' } };
        const result = verifyFilePath(noIndexManifest, '/missing-dir', 'somehash', true);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });
});

describe('normalizeManifestData', () => {
    it('handles enhanced format with files section', () => {
        const input = {
            files: { '/app.js': 'abc123', '/style.css': 'def456' },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
        expect(result.files['/style.css']).toBe('def456');
    });

    it('handles enhanced format with object entries', () => {
        const input = {
            files: { '/app.js': { hash: 'abc123' } },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('handles legacy flat format with string values', () => {
        const input = { '/app.js': 'abc123' };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('handles legacy flat format with object entries', () => {
        const input = { '/app.js': { hash: 'abc123' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('preserves SRI hashes as-is (no encoding conversion)', () => {
        const sriHash = 'sha256-' + btoa('test');
        const input = { files: { '/app.js': sriHash } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe(sriHash);
    });

    it('returns empty files for non-object input', () => {
        // Note: null passes typeof === 'object' so it throws — only test primitives
        expect(normalizeManifestData(42)).toEqual({ files: {} });
        expect(normalizeManifestData(undefined)).toEqual({ files: {} });
    });

    it('skips entries with no hash value', () => {
        const input = { files: { '/app.js': null, '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBeUndefined();
        expect(result.files['/ok.js']).toBe('hash');
    });

    it('line 112: legacy flat format with object entry with null hash is skipped', () => {
        const input = { '/app.js': { hash: null }, '/ok.js': { hash: 'sha256-abc' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBeUndefined();
        expect(result.files['/ok.js']).toBe('sha256-abc');
    });

    it('preserves top-level fields (mode, metadata, future fields) in enhanced format', () => {
        const input = {
            files: { '/app.js': 'abc' },
            mode: 'reporting',
            metadata: { extensions: ['.js', '.wasm'] },
            customField: { future: true },
        };
        const result = normalizeManifestData(input);
        expect(result.mode).toBe('reporting');
        expect(result.metadata).toEqual({ extensions: ['.js', '.wasm'] });
        expect(result.customField).toEqual({ future: true });
        expect(result.files['/app.js']).toBe('abc');
    });
});

describe('getFileKey', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin URLs', () => {
        expect(getFileKey('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(getFileKey('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(getFileKey('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        // When URL parsing fails, falls back to prepending /
        expect(getFileKey('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(getFileKey('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });

    it('line 142: catch fallback prepends / for bare relative URL with invalid base', () => {
        expect(getFileKey('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('line 142: catch fallback returns url as-is when it already starts with /', () => {
        expect(getFileKey('/already-absolute', 'not-a-valid-url')).toBe('/already-absolute');
    });
});

describe('shouldVerifyAsset', () => {
    it('returns true for navigation requests', () => {
        const resp = new Response('', { headers: { 'content-type': 'text/plain' } });
        expect(shouldVerifyAsset('/some/path', true, resp, ['.js'], [])).toBe(true);
    });

    it('returns true when extension matches', () => {
        const resp = new Response('', { headers: { 'content-type': 'text/plain' } });
        expect(shouldVerifyAsset('/app.js', false, resp, ['.js'], [])).toBe(true);
    });

    it('line 179: returns true when content-type matches and no extension match', () => {
        const resp = new Response('', { headers: { 'content-type': 'application/javascript' } });
        expect(shouldVerifyAsset('/api/bundle', false, resp, [], ['application/javascript'])).toBe(
            true
        );
    });

    it('line 186: returns false when no extension match and no content-type match', () => {
        const resp = new Response('', { headers: { 'content-type': 'text/plain' } });
        expect(
            shouldVerifyAsset('/api/data', false, resp, ['.js'], ['application/javascript'])
        ).toBe(false);
    });

    it('returns false when response has no content-type header and no extension match', () => {
        const resp = new Response('');
        expect(shouldVerifyAsset('/no-ext', false, resp, ['.js'], ['application/javascript'])).toBe(
            false
        );
    });

    it('line 179: uses empty string when response is null (no content-type available)', () => {
        expect(shouldVerifyAsset('/no-ext', false, null, ['.js'], ['application/javascript'])).toBe(
            false
        );
    });

    it('line 186: mime is empty (none) when response has no content-type header', () => {
        const resp = { headers: { get: () => null } };
        expect(shouldVerifyAsset('/no-ext', false, resp, ['.js'], ['application/javascript'])).toBe(
            false
        );
    });
});

describe('verifyManifestSignature', () => {
    const privKey = new Uint8Array(32).fill(0);
    privKey[31] = 42;

    const payload = { files: { '/app.js': 'sha256-abc' }, mode: 'reporting' };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));

    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
    });

    it('noble-secp256k1-recovered-eth MATCH: recovered address equals expected', () => {
        const msgHash = keccak_256(payloadBytes);
        const sigBytes = sign(msgHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);
        const pubKey = recoverPublicKey(sigBytes, msgHash, { prehash: false });
        const expectedAddress = ethereumAddress(pubKey);

        const result = verifyManifestSignature('noble-secp256k1-recovered-eth', expectedAddress, {
            pay: payload,
            sig: sigHex,
        });

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.payload).toEqual(payload);
    });

    it('noble-secp256k1-recovered-eth MISMATCH: wrong expected address returns MISMATCH', () => {
        const msgHash = keccak_256(payloadBytes);
        const sigBytes = sign(msgHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);

        const result = verifyManifestSignature(
            'noble-secp256k1-recovered-eth',
            '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            { pay: payload, sig: sigHex }
        );

        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.expectedHash).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
        expect(result.actualHash).toBeDefined();
    });

    it('noble-secp256k1-recovered-eth ERROR: malformed sig hex throws and returns ERROR', () => {
        const result = verifyManifestSignature('noble-secp256k1-recovered-eth', '0xABC', {
            pay: payload,
            sig: 'not-valid-hex!!!',
        });

        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });

    it('personal-sign-alt MATCH: recovered address equals expected', () => {
        const msgHash = keccak_256(payloadBytes);
        const prefix = '\x19Ethereum Signed Message:\n';
        const prefixAndLen = new TextEncoder().encode(prefix + msgHash.length);
        const messageHash = keccak_256(etc.concatBytes(prefixAndLen, msgHash));

        const sigBytes = sign(messageHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);
        const pubKey = recoverPublicKey(sigBytes, messageHash, { prehash: false });
        const expectedAddress = ethereumAddress(pubKey);

        const result = verifyManifestSignature('personal-sign-alt', expectedAddress, {
            pay: payload,
            sig: sigHex,
        });

        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.payload).toEqual(payload);
    });
});

describe('createSingleFlight', () => {
    it('returns the result of the function', async () => {
        const sf = createSingleFlight();
        const result = await sf(async () => 42);
        expect(result).toBe(42);
    });

    it('deduplicates concurrent calls', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = () =>
            new Promise((resolve) => {
                callCount++;
                setTimeout(() => resolve('done'), 10);
            });

        const [a, b] = await Promise.all([sf(fn), sf(fn)]);
        expect(callCount).toBe(1);
        expect(a).toBe('done');
        expect(b).toBe('done');
    });

    it('allows a new call after the previous one completes', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = async () => ++callCount;

        await sf(fn);
        await sf(fn);
        expect(callCount).toBe(2);
    });

    it('resets after rejection so the next call retries', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const failOnce = async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error('fail');
            }
            return 'ok';
        };

        await expect(sf(failOnce)).rejects.toThrow('fail');
        const result = await sf(failOnce);
        expect(result).toBe('ok');
        expect(callCount).toBe(2);
    });
});
