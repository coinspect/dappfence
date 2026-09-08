const secp = require('@noble/secp256k1');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
secp.hashes.sha256 = sha256;

/**
 * Calculate Ethereum address from a compressed public key
 */
function ethereumAddress(compressedPubKey) {
    const point = secp.Point.fromBytes(compressedPubKey);
    const keccak = keccak_256(point.toBytes(false).slice(1));
    return '0x' + secp.etc.bytesToHex(keccak.slice(-20));
}

/**
 * Signs a message using secp256k1 and returns the hex signature
 */
function sign(msg, secretKey) {
    return secp.etc.bytesToHex(
        secp.sign(msg, secretKey, {
            format: 'recovered',
            prehash: false,
            lowS: true,
        })
    );
}

function recoverSigner(msgHash, signature) {
    const sigBytes = secp.etc.hexToBytes(signature);
    const compressedPubKey = secp.recoverPublicKey(sigBytes, msgHash, { prehash: false });
    const point = secp.Point.fromBytes(compressedPubKey);
    const keccak = keccak_256(point.toBytes(false).slice(1));
    return '0x' + secp.etc.bytesToHex(keccak.slice(-20));
}

function recoverPersonalSign(msgHash, signature) {
    const sigBytes = secp.etc.hexToBytes(signature);
    const prefix = '\x19Ethereum Signed Message:\n';
    const messageHash = keccak_256(
        secp.etc.concatBytes(new TextEncoder('utf-8').encode(prefix + msgHash.length), msgHash)
    );
    const compressedPubKey = secp.recoverPublicKey(sigBytes, messageHash, { prehash: false });
    const point = secp.Point.fromBytes(compressedPubKey);
    const keccak = keccak_256(point.toBytes(false).slice(1));
    return '0x' + secp.etc.bytesToHex(keccak.slice(-20));
}

function getPublicKey(secretKey) {
    return secp.getPublicKey(secretKey);
}

function hexToBytes(hex) {
    return secp.etc.hexToBytes(hex);
}

const bytesToHex = secp.etc.bytesToHex;
const keccak256 = keccak_256;

module.exports = {
    recoverSigner,
    recoverPersonalSign,
    sign,
    ethereumAddress,
    getPublicKey,
    hexToBytes,
    bytesToHex,
    keccak256,
};
