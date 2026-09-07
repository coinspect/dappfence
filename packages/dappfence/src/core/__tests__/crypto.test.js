import { describe, it, expect, beforeAll } from 'vitest';
import {
    calculateHash,
    ethereumAddress,
    recoverEthereumAddress,
    recoverPersonalSign,
} from '../crypto.js';
import { sign, etc, Point, hashes, recoverPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

beforeAll(() => {
    hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
    hashes.sha256 = sha256;
});

describe('calculateHash', () => {
    it('returns an SRI string for given input', async () => {
        const hash = await calculateHash(new TextEncoder().encode('hello'));
        // sha256- prefix + 44 standard-base64 chars (with `=` padding)
        expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    });

    it('returns consistent hashes for the same input', async () => {
        const input = new TextEncoder().encode('test content');
        const hash1 = await calculateHash(input);
        const hash2 = await calculateHash(input);
        expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different input', async () => {
        const hash1 = await calculateHash(new TextEncoder().encode('a'));
        const hash2 = await calculateHash(new TextEncoder().encode('b'));
        expect(hash1).not.toBe(hash2);
    });

    it('produces the known SHA-256 of an empty string in SRI form', async () => {
        const hash = await calculateHash(new TextEncoder().encode(''));
        expect(hash).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    });

    it('matches the canonical SRI encoding (standard base64, with padding) used by the signer', async () => {
        // The signer emits hashes via Buffer.toString('base64') in Node — same
        // encoding as `btoa` here. A drift in either side (base64url, missing
        // padding, etc.) would silently break manifest hash comparisons, so
        // pin a known input to a known output.
        const hash = await calculateHash(new TextEncoder().encode('abc'));
        expect(hash).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    });
});

describe('ethereumAddress', () => {
    it('returns a 0x-prefixed 42-character lowercase hex address for generator point G', () => {
        const addr = ethereumAddress(Point.BASE.toBytes(true));
        expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
        expect(addr).toHaveLength(42);
    });

    it('returns different addresses for different public keys', () => {
        const privKey1 = new Uint8Array(32).fill(0);
        privKey1[31] = 1;
        const privKey2 = new Uint8Array(32).fill(0);
        privKey2[31] = 2;

        const msgHash = keccak_256(new TextEncoder().encode('msg'));
        const sig1 = sign(msgHash, privKey1, { prehash: false, format: 'recovered' });
        const sig2 = sign(msgHash, privKey2, { prehash: false, format: 'recovered' });

        const pub1 = recoverPublicKey(sig1, msgHash, { prehash: false });
        const pub2 = recoverPublicKey(sig2, msgHash, { prehash: false });

        expect(ethereumAddress(pub1)).not.toBe(ethereumAddress(pub2));
    });
});

describe('recoverEthereumAddress', () => {
    it('returns a 0x-prefixed 42-character lowercase hex address', () => {
        const privKey = new Uint8Array(32).fill(0);
        privKey[31] = 1;

        const msg = new TextEncoder().encode('hello dappfence');
        const msgHash = keccak_256(msg);
        const sigBytes = sign(msgHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);

        const recovered = recoverEthereumAddress(msg, sigHex);

        expect(recovered).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it('returns the same address as ethereumAddress for the corresponding public key', () => {
        const privKey = new Uint8Array(32).fill(0);
        privKey[31] = 3;

        const msg = new TextEncoder().encode('test message');
        const msgHash = keccak_256(msg);
        const sigBytes = sign(msgHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);

        const pubKey = recoverPublicKey(sigBytes, msgHash, { prehash: false });
        const expected = ethereumAddress(pubKey);

        const recovered = recoverEthereumAddress(msg, sigHex);

        expect(recovered).toBe(expected);
    });

    it('returns different addresses for different signers', () => {
        const privKey1 = new Uint8Array(32).fill(0);
        privKey1[31] = 1;
        const privKey2 = new Uint8Array(32).fill(0);
        privKey2[31] = 2;

        const msg = new TextEncoder().encode('same message');
        const msgHash = keccak_256(msg);

        const sig1 = sign(msgHash, privKey1, { prehash: false, format: 'recovered' });
        const sig2 = sign(msgHash, privKey2, { prehash: false, format: 'recovered' });

        const addr1 = recoverEthereumAddress(msg, etc.bytesToHex(sig1));
        const addr2 = recoverEthereumAddress(msg, etc.bytesToHex(sig2));

        expect(addr1).not.toBe(addr2);
    });
});

describe('recoverPersonalSign', () => {
    it('returns a 0x-prefixed 42-character lowercase hex address', () => {
        const privKey = new Uint8Array(32).fill(0);
        privKey[31] = 5;

        const msg = new TextEncoder().encode('hello personal sign');
        const msgHash = keccak_256(msg);
        const prefix = '\x19Ethereum Signed Message:\n';
        const prefixAndLen = new TextEncoder().encode(prefix + msgHash.length);
        const messageHash = keccak_256(etc.concatBytes(prefixAndLen, msgHash));

        const sigBytes = sign(messageHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);

        const recovered = recoverPersonalSign(msg, sigHex);

        expect(recovered).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it('returns same address as ethereumAddress for the corresponding public key', () => {
        const privKey = new Uint8Array(32).fill(0);
        privKey[31] = 7;

        const msg = new TextEncoder().encode('personal sign test');
        const msgHash = keccak_256(msg);
        const prefix = '\x19Ethereum Signed Message:\n';
        const prefixAndLen = new TextEncoder().encode(prefix + msgHash.length);
        const messageHash = keccak_256(etc.concatBytes(prefixAndLen, msgHash));

        const sigBytes = sign(messageHash, privKey, { prehash: false, format: 'recovered' });
        const sigHex = etc.bytesToHex(sigBytes);

        const pubKey = recoverPublicKey(sigBytes, messageHash, { prehash: false });
        const expected = ethereumAddress(pubKey);

        const recovered = recoverPersonalSign(msg, sigHex);

        expect(recovered).toBe(expected);
    });

    it('returns different addresses for different signers', () => {
        const privKey1 = new Uint8Array(32).fill(0);
        privKey1[31] = 1;
        const privKey2 = new Uint8Array(32).fill(0);
        privKey2[31] = 2;

        const msg = new TextEncoder().encode('same message');
        const msgHash = keccak_256(msg);
        const prefix = '\x19Ethereum Signed Message:\n';
        const prefixAndLen = new TextEncoder().encode(prefix + msgHash.length);
        const messageHash = keccak_256(etc.concatBytes(prefixAndLen, msgHash));

        const sig1 = sign(messageHash, privKey1, { prehash: false, format: 'recovered' });
        const sig2 = sign(messageHash, privKey2, { prehash: false, format: 'recovered' });

        const addr1 = recoverPersonalSign(msg, etc.bytesToHex(sig1));
        const addr2 = recoverPersonalSign(msg, etc.bytesToHex(sig2));

        expect(addr1).not.toBe(addr2);
    });
});
