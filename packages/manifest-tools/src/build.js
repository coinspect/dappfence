/**
 * Signed integrity manifest builder.
 * Pure functions for hashing files and signing manifests.
 */
const crypto = require('crypto');
const { sign, ethereumAddress, keccak256 } = require('./crypto');

/**
 * Calculate SHA-256 hash of a file buffer or path.
 * @param {Buffer|string} input - File buffer or file path
 * @returns {string} SRI hash like "sha256-..."
 */
function calculateFileHash(input) {
    const buffer = typeof input === 'string' ? require('fs').readFileSync(input) : input;
    const hash = crypto.createHash('sha256').update(buffer).digest('base64');
    return `sha256-${hash}`;
}

/**
 * Calculate SHA-256 hash of a string.
 * @param {string} content
 * @returns {string} SRI hash like "sha256-..."
 */
function calculateStringHash(content) {
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
    return `sha256-${hash}`;
}

/**
 * Sign a manifest payload and return the signed JSON string.
 * @param {object} manifestData - The manifest payload (e.g. { files: { ... }, metadata: { ... } })
 * @param {object} keys
 * @param {Uint8Array} keys.publicKey
 * @param {Uint8Array} keys.secretKey
 * @returns {{ pay: object, sig: string, identity: string, signatureType: string }}
 */
function signManifest(manifestData, { publicKey, secretKey }) {
    const identity = ethereumAddress(publicKey);
    const msg = new TextEncoder('utf-8').encode(JSON.stringify(manifestData, null, 2));
    const msgHash = keccak256(msg);
    const sig = sign(msgHash, secretKey);
    return {
        pay: manifestData,
        sig,
        identity,
        signatureType: 'noble-secp256k1-recovered-eth',
    };
}

module.exports = { calculateFileHash, calculateStringHash, signManifest };
