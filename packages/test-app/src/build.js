/**
 * Build Manifest Script
 * Generates integrity manifests with real SHA-256 hashes of assets
 * and creates example HTML with the correct SRI manifest hash.
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { calculateFileHash, signManifest } = require('@dappfence/manifest-tools');
const {
    recoverPersonalSign,
    ethereumAddress,
    bytesToHex,
    keccak256,
} = require('@dappfence/manifest-tools/crypto');
const {
    BUILD_TARGETS,
    OUT_DIR,
    keys,
    EXTERNAL_ASSETS,
    SECURITY_CONTENT_TYPES,
} = require('./build-config');

let log = console.log;

function getFileExtension(filePath) {
    const lastDot = filePath.lastIndexOf('.');
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (lastDot === -1 || lastDot < lastSlash) {
        return null;
    }
    return filePath.substring(lastDot).toLowerCase();
}

function findSecurityCriticalFiles(dir, baseDir = dir) {
    const securityFiles = [];
    if (!fs.existsSync(dir)) {
        return securityFiles;
    }
    for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!['node_modules', '.git', 'dist', 'build'].includes(file)) {
                securityFiles.push(...findSecurityCriticalFiles(filePath, baseDir));
            }
        } else {
            const extension = getFileExtension(file);
            if (extension && SECURITY_CONTENT_TYPES[extension]) {
                const relativePath = path.relative(baseDir, filePath);
                const webPath = '/' + relativePath.replace(/\\/g, '/');
                securityFiles.push({
                    webPath,
                    filePath,
                    extension,
                    contentType: SECURITY_CONTENT_TYPES[extension] || null,
                });
            }
        }
    }
    return securityFiles;
}

function render(inputPath, outFile, signature, args) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Template not found: ${inputPath}`);
    }
    const vars = {
        MANIFEST_SIGNATURE_IDENTITY: signature.identity,
        MANIFEST_SIGNATURE_TYPE: signature.type,
        BUILD_DATE: new Date().toISOString(),
        MANIFEST_FILE: args.manifestFile,
        TARGET_VERSION: 'VERSION: ' + args.version,
        ...(args.templateFlags || {}),
    };
    let data = fs.readFileSync(inputPath, 'utf8');
    data = data.replace(
        /<!--\s*#IF\s+(\w+)\s*-->([\s\S]*?)(?:<!--\s*#ELSE\s*-->([\s\S]*?))?<!--\s*\/IF\s*-->/g,
        (_, key, ifContent, elseContent) => (vars[key] ? ifContent : elseContent || '')
    );
    data = data.replace(/\{\{(\w+)\}\}/g, (match, key) =>
        vars[key] !== undefined ? vars[key] : match
    );
    data = data.replace(/\n\s*\n\s*\n/g, '\n\n');
    const outputPath = path.join(args.outDir, outFile);
    fs.writeFileSync(outputPath, data);
    log(`  Render: ${outputPath}`);
}

async function buildTarget(targetName, target, { personalSign = false }, version = 'latest') {
    log(`Building integrity manifest for: ${target.description}`);
    const outDir = target.outDir + '_' + version;
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const signatureData = {
        identity: ethereumAddress(keys.publicKey),
        type: personalSign ? 'personal-sign-alt' : 'noble-secp256k1-recovered-eth',
    };
    log(`Manifest signer: ${signatureData.identity}`);

    const manifestData = {
        files: {},
        mode: target.manifestMode,
        metadata: {
            extensions: new Set(),
            contentTypes: new Set(),
            buildTime: new Date().toISOString(),
            version,
            target: targetName,
        },
    };

    function addToManifest(fileName, extension, contentType) {
        const outPath = path.join(outDir, fileName);
        const hash = calculateFileHash(outPath);
        manifestData.files[fileName] = hash;
        manifestData.metadata.extensions.add(extension);
        manifestData.metadata.contentTypes.add(contentType);
        log(
            `  ${fileName}: ${hash} == ${Buffer.from(hash.substring(7), 'base64').toString('hex')}`
        );
    }

    // Add DappFence framework
    if (!fs.existsSync(target.dappfencePath))
        throw new Error(`/dappfence.js: File not found at ${target.dappfencePath}`);
    const dappfenceDestPath = path.join(outDir, 'dappfence.js');
    if (!version) {
        fs.copyFileSync(target.dappfencePath, dappfenceDestPath);
    } else {
        const data = fs.readFileSync(target.dappfencePath, 'utf-8');
        fs.writeFileSync(dappfenceDestPath, `// VERSION: ${version}\r\n` + data);
    }
    addToManifest('/dappfence.js', '.js', 'text/javascript');

    for (const [template, destination] of Object.entries(target.htmlTemplates)) {
        render(path.join(target.templateDir, template), destination, signatureData, {
            ...target,
            outDir,
            version,
        });
        addToManifest('/' + destination, '.html', 'text/html');
    }

    if (target.indexCopies) {
        for (const copy of target.indexCopies) {
            const sourcePath = path.join(outDir, 'index.html');
            const destPath = path.join(outDir, copy);
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(sourcePath, destPath);
            addToManifest(`/${copy}`, '.html', 'text/html');
        }
    }

    // Find and hash security-critical files
    const securityFiles = findSecurityCriticalFiles(target.assetDir);
    const exclude = target.exclude || [];
    for (const { webPath, filePath, extension, contentType } of securityFiles) {
        if (exclude.some((e) => webPath.startsWith(e))) {
            continue;
        }
        fs.copyFileSync(filePath, path.join(outDir, webPath));
        addToManifest(webPath, extension, contentType);
    }

    // Add external assets
    for (const [url, hash] of Object.entries(EXTERNAL_ASSETS)) {
        manifestData.files[url] = hash;
        manifestData.metadata.extensions.add('.js');
        manifestData.metadata.contentTypes.add('text/javascript');
    }

    manifestData.metadata.extensions = Array.from(manifestData.metadata.extensions);
    manifestData.metadata.contentTypes = Array.from(manifestData.metadata.contentTypes);
    log(`Total assets: ${Object.keys(manifestData.files).length}`);

    // Sign the manifest
    let signedManifest;
    if (personalSign) {
        const msg = new TextEncoder('utf-8').encode(JSON.stringify(manifestData, null, 2));
        const msgHash = keccak256(msg);
        let signature = await new Promise((resolve) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(
                `sign with wallet ${signatureData.identity} hash 0x${bytesToHex(msgHash).toLowerCase()}\n`,
                (answer) => {
                    resolve(answer);
                    rl.close();
                }
            );
        });
        signature = signature.toLowerCase().replace(/^0x/, '');
        const recovered = recoverPersonalSign(msgHash, signature);
        if (recovered.toLowerCase() !== signatureData.identity.toLowerCase()) {
            throw new Error(
                `invalid signature 0x${signature}, ${signatureData.identity} != ${recovered}`
            );
        }
        signedManifest = { pay: manifestData, sig: signature };
    } else {
        const { pay, sig } = signManifest(manifestData, keys);
        signedManifest = { pay, sig };
    }

    const manifestPath = path.join(outDir, target.manifestFile);
    fs.writeFileSync(manifestPath, JSON.stringify(signedManifest, null, 2));
    log(`Manifest written to: ${manifestPath}`);
}

// CLI
if (require.main === module) {
    if (process.argv.some((x) => x.toLowerCase().includes('--quiet'))) log = () => {};
    const useWallet = process.argv.some((x) => x.toLowerCase().includes('--wallet'));
    const idx = process.argv.indexOf(__filename);
    const targetArgs = process.argv.slice(idx + 1).filter((x) => !x.startsWith('-'));
    const targets = targetArgs.length > 0 ? targetArgs : Object.keys(BUILD_TARGETS);

    log('Deleting out directory:', OUT_DIR);
    fs.rmSync(OUT_DIR, { recursive: true, force: true });

    for (const targetName of targets) {
        const target = BUILD_TARGETS[targetName];
        if (!target) {
            console.error(
                `Unknown target: ${targetName}. Available: ${Object.keys(BUILD_TARGETS).join(', ')}`
            );
            process.exit(1);
        }
        console.log(`Build target: ${targetName}`);
        buildTarget(targetName, target, { personalSign: useWallet }).catch((error) => {
            console.error('Build failed:', error);
            process.exit(1);
        });
        for (const version of target.versions || []) {
            console.log(`Build target: ${targetName} version: ${version}`);
            buildTarget(targetName, target, { personalSign: useWallet }, version).catch((error) => {
                console.error('Build failed:', error);
                process.exit(1);
            });
        }
    }
}
