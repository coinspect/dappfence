/**
 * Cryptographic utilities: hashing, SRI conversion, and Ethereum signature recovery.
 */

import { etc, hashes, Point, recoverPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
hashes.sha256 = sha256;

/**
 * Calculate SHA-256 hash of a buffer in SRI format.
 * Output format: `sha256-${standard-base64-with-padding}` — matches what
 * the signer emits and what HTML's Subresource Integrity attribute uses,
 * so manifest values and runtime hashes can compare with `===` directly.
 * @param {BufferSource} buffer - Data to hash
 * @returns {Promise<string>} SRI hash, e.g. "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
 */
export async function calculateHash(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(hashBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return `sha256-${btoa(binary)}`;
}

/**
 * Calculate Ethereum address from a compressed public key.
 * @param {Uint8Array} compressedPubKey - Compressed secp256k1 public key
 * @returns {string} Ethereum address with 0x prefix
 */
export function ethereumAddress(compressedPubKey) {
    const point = Point.fromBytes(compressedPubKey);
    const keccak = keccak_256(point.toBytes(false).slice(1));
    return '0x' + etc.bytesToHex(keccak.slice(-20));
}

/**
 * Recover Ethereum address from a message and secp256k1 signature.
 * @param {Uint8Array} msg - The original message bytes
 * @param {string} signature - Hex-encoded signature
 * @returns {string} Recovered Ethereum address
 */
export function recoverEthereumAddress(msg, signature) {
    const msgHash = keccak_256(msg);
    const sigBytes = etc.hexToBytes(signature);
    return ethereumAddress(recoverPublicKey(sigBytes, msgHash, { prehash: false }));
}

/**
 * Recover Ethereum address from a wallet personal_sign message using the signature.
 * @param {Uint8Array} msg - The original message bytes
 * @param {string} signature - Hex-encoded signature
 * @returns {string} Recovered Ethereum address
 */
export function recoverPersonalSign(msg, signature) {
    const msgHash = keccak_256(msg);
    const sigBytes = etc.hexToBytes(signature);

    // Message Hash
    const prefix = '\x19Ethereum Signed Message:\n';
    // TextEncoder encodes to UTF-8.
    const messageHash = keccak_256(
        etc.concatBytes(new TextEncoder().encode(prefix + msgHash.length), msgHash)
    );
    return ethereumAddress(recoverPublicKey(sigBytes, messageHash, { prehash: false }));
}
