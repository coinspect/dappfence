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
const { BUILD_TARGETS, OUT_DIR, keys, EXTERNAL_ASSETS } = require('./build-config');

let log = console.log;

function render(inputPath, outFile, signatureData, args) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Template not found: ${inputPath}`);
    }
    const vars = {
        MANIFEST_SIGNATURE_IDENTITY: signatureData.identity,
        MANIFEST_SIGNATURE_TYPE: signatureData.type,
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

function renderPages(target, outDir, signatureData, version) {
    for (const [output, page] of Object.entries(target.pages || {})) {
        const pageDir = path.dirname(path.join(outDir, output));
        if (!fs.existsSync(pageDir)) fs.mkdirSync(pageDir, { recursive: true });
        render(path.join(target.templateDir, page.template), output, signatureData, {
            ...target,
            manifestFile: page.manifest,
            outDir,
            version,
        });
    }
}

function findAssetFiles(dir, baseDir = dir) {
    const files = [];
    if (!fs.existsSync(dir)) {
        return files;
    }
    for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!['node_modules', '.git', 'dist', 'build'].includes(file)) {
                files.push(...findAssetFiles(filePath, baseDir));
            }
        } else {
            const relativePath = path.relative(baseDir, filePath);
            files.push({ webPath: '/' + relativePath.replace(/\\/g, '/'), filePath });
        }
    }
    return files;
}

function copySourceFiles(target, outDir, version) {
    if (!fs.existsSync(target.dappfencePath)) {
        throw new Error(`/dappfence.js: File not found at ${target.dappfencePath}`);
    }
    const dappfenceDestPath = path.join(outDir, 'dappfence.js');
    if (!version) {
        fs.copyFileSync(target.dappfencePath, dappfenceDestPath);
    } else {
        const data = fs.readFileSync(target.dappfencePath, 'utf-8');
        fs.writeFileSync(dappfenceDestPath, `// VERSION: ${version}\r\n` + data);
    }

    const exclude = target.exclude || [];
    for (const { webPath, filePath } of findAssetFiles(target.assetDir)) {
        if (exclude.some((e) => webPath.startsWith(e))) {
            continue;
        }
        const destPath = path.join(outDir, webPath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(filePath, destPath);
    }
}

function hashOutputFiles(outDir) {
    const files = {};
    for (const { webPath } of findAssetFiles(outDir)) {
        const hash = calculateFileHash(path.join(outDir, webPath));
        files[webPath] = hash;
        log(`  ${webPath}: ${hash} == ${Buffer.from(hash.substring(7), 'base64').toString('hex')}`);
    }
    log(`Total files: ${Object.keys(files).length}`);
    return files;
}

async function writeSignedManifest(manifests, outDir, { personalSign, signatureData }) {
    for (const { manifestFile, data } of manifests) {
        let signedManifest;
        if (personalSign) {
            const msg = new TextEncoder('utf-8').encode(JSON.stringify(data, null, 2));
            const msgHash = keccak256(msg);
            let signature = await new Promise((resolve) => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout,
                });
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
            signedManifest = { pay: data, sig: signature };
        } else {
            const { pay, sig } = signManifest(data, keys);
            signedManifest = { pay, sig };
        }
        const outPath = path.join(outDir, manifestFile);
        fs.writeFileSync(outPath, JSON.stringify(signedManifest, null, 2));
        log(`Manifest written to: ${outPath}`);
    }
}

function buildManifestsData(target, sharedFiles, { targetName, version }) {
    return Object.entries(target.manifests || {}).map(([manifestFile, manifest]) => {
        const additionalFileHashes = {};
        for (const [manifestKey, relPaths] of Object.entries(manifest.additionalFiles || {})) {
            const hashes = relPaths.map((p) => calculateFileHash(path.join(target.assetDir, p)));
            additionalFileHashes[manifestKey] = hashes;
            log(`  ${manifestKey}: ${hashes.join(', ')}`);
        }

        const data = {
            files: { ...sharedFiles, ...additionalFileHashes, ...EXTERNAL_ASSETS },
            mode: manifest.mode,
            pathRules: manifest.pathRules || [],
            contentRules: manifest.contentRules || null,
            metadata: { buildTime: new Date().toISOString(), version, target: targetName },
        };

        log(`Manifest ${manifestFile}: ${Object.keys(data.files).length} assets`);
        return { manifestFile, data };
    });
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

    copySourceFiles(target, outDir, version);
    renderPages(target, outDir, signatureData, version);
    const sharedFiles = hashOutputFiles(outDir);
    const manifests = buildManifestsData(target, sharedFiles, { targetName, version });
    await writeSignedManifest(manifests, outDir, { personalSign, signatureData });
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
