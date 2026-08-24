/**
 * Signed integrity manifest builder.
 * Pure functions for hashing files and signing manifests.
 */
const crypto = require('crypto');
const {
    sign,
    ethereumAddress,
    getPublicKey,
    hexToBytes,
    keccak256,
    recoverSigner,
} = require('./crypto');

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
 * @param {string|Uint8Array} keys.secretKey - Hex string (with or without 0x) or raw bytes
 * @returns {{ pay: object, sig: string, identity: string, signatureType: string }}
 */
function signManifest(manifestData, { secretKey }) {
    const skBytes =
        typeof secretKey === 'string' ? hexToBytes(secretKey.replace(/^0x/, '')) : secretKey;
    const pkBytes = getPublicKey(skBytes);
    const identity = ethereumAddress(pkBytes);
    const msg = new TextEncoder('utf-8').encode(JSON.stringify(manifestData, null, 2));
    const msgHash = keccak256(msg);
    const sig = sign(msgHash, skBytes);
    return {
        pay: manifestData,
        sig,
        identity,
        signatureType: 'noble-secp256k1-recovered-eth',
    };
}

/**
 * Derive the Ethereum signer identity from a secret key hex string.
 * @param {string} secretKeyHex - 64-char hex, with or without 0x prefix
 * @returns {string} Ethereum address like "0x..."
 */
function deriveIdentity(secretKeyHex) {
    const sk = hexToBytes(secretKeyHex.replace(/^0x/, ''));
    const pk = getPublicKey(sk);
    return ethereumAddress(pk);
}

/**
 * Verify a signed manifest file.
 * @param {string} manifestPath - Path to the manifest JSON file
 * @returns {{ identity: string }} the verified signer identity
 * @throws if unsigned or signature does not match the embedded identity
 */
function verifyManifest(manifestPath) {
    const { sig, pay, identity } = JSON.parse(require('fs').readFileSync(manifestPath, 'utf-8'));
    if (!sig || !identity) {
        throw new Error('manifest is unsigned');
    }
    const msg = new TextEncoder('utf-8').encode(JSON.stringify(pay, null, 2));
    const msgHash = keccak256(msg);
    const recovered = recoverSigner(msgHash, sig);
    if (recovered.toLowerCase() !== identity.toLowerCase()) {
        throw new Error(`signature mismatch — expected ${identity}, recovered ${recovered}`);
    }
    return { identity };
}

module.exports = {
    calculateFileHash,
    calculateStringHash,
    signManifest,
    verifyManifest,
    deriveIdentity,
};
