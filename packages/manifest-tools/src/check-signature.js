const fs = require('fs');
const { keccak256, ethereumAddress, getPublicKey, recoverPersonalSign } = require('./crypto');

function checkSignature(manifestPath, secretKeyHex) {
    const { hexToBytes } = require('./crypto');
    const secretKey = hexToBytes(secretKeyHex);
    const publicKey = getPublicKey(secretKey);
    const { sig, pay } = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const msg = new TextEncoder('utf-8').encode(JSON.stringify(pay, null, 2));
    const msgHash = keccak256(msg);
    const manifestSigner = ethereumAddress(publicKey);
    const recovered = recoverPersonalSign(msgHash, sig);
    if (recovered.toLowerCase() !== manifestSigner.toLowerCase()) {
        throw new Error(`invalid signature 0x${sig}, ${manifestSigner} != ${recovered}`);
    }
    return recovered;
}

module.exports = { checkSignature };

if (require.main === module) {
    const idx = process.argv.findIndex((x) => x == __filename);
    if (process.argv.length <= idx + 1) {
        console.error(`Usage: ${process.argv[idx]} manifestFile`);
        process.exit(1);
    }
    try {
        const recovered = checkSignature(process.argv[idx + 1]);
        console.log(`success ${recovered}`);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
