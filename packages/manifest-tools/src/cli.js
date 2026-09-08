#!/usr/bin/env node
/**
 * dappfence-manifest — CLI for @dappfence/manifest-tools
 *
 * Commands:
 *   hash <file...>    Print SHA-256 hashes in hex and SRI format
 *   verify <manifest> Verify a manifest's signature against its embedded identity
 *   sign <dir>        Hash all files in a directory and write a signed manifest
 *
 * Usage:
 *   dappfence-manifest hash dist/app.js dist/style.css
 *   dappfence-manifest verify integrity-manifest.json
 *   dappfence-manifest sign ./out --secret-key <hex> --script-src /dappfence.js
 */
const { calculateFileHash, verifyManifest, deriveIdentity } = require('./build');
const { generateManifest, buildScriptAttrs, buildScriptTag } = require('./manifest');
const fs = require('fs');
const path = require('path');

function usage() {
    console.log(`Usage:
  dappfence-manifest hash <file...>
  dappfence-manifest verify <manifest>
  dappfence-manifest sign <dir> [options]

Options for sign:
  --secret-key <hex>     Signing key hex (or DAPPFENCE_SECRET_KEY env var)
  --out <path>           Manifest output path (default: <dir>/integrity-manifest.json)
  --script-src <path>    dappfence.js URL for script tag injection (default: /dappfence.js)
  --manifest-url <url>   Public manifest URL (default: /integrity-manifest.json)
  --mode <mode>          protected or reporting (default: protected)
  --no-inject            Skip script tag injection into HTML files
  --exclude <paths>      Comma-separated web path prefixes to exclude`);
}

function cmdHash(files) {
    if (!files.length) {
        console.error('Error: at least one file is required');
        process.exit(1);
    }
    const multi = files.length > 1;
    for (const file of files) {
        try {
            const sri = calculateFileHash(file);
            const buf = fs.readFileSync(file);
            const hex = require('crypto').createHash('sha256').update(buf).digest('hex');
            if (multi) console.log(file);
            console.log(`  hex: ${hex}`);
            console.log(`  sri: ${sri}`);
        } catch (err) {
            console.error(`${file}: ${err.message}`);
            process.exitCode = 1;
        }
    }
}

function cmdVerify(manifestPath) {
    if (!manifestPath) {
        console.error('Error: manifest path is required');
        process.exit(1);
    }
    try {
        const { identity } = verifyManifest(manifestPath);
        console.log(`✓ valid — signed by ${identity}`);
    } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
    }
}

async function cmdSign(dir, args) {
    if (!dir) {
        console.error('Error: directory is required');
        process.exit(1);
    }

    const secretKey = args['--secret-key'] || process.env.DAPPFENCE_SECRET_KEY || null;
    const manifestPath = args['--out'] || 'integrity-manifest.json';
    const scriptSrc = args['--script-src'] || '/dappfence.js';
    const manifestUrl = args['--manifest-url'] || '/integrity-manifest.json';
    const mode = args['--mode'] || 'protected';
    const noInject = '--no-inject' in args;
    const exclude = args['--exclude'] ? args['--exclude'].split(',') : [];

    const outDir = path.resolve(dir);
    if (!fs.existsSync(outDir)) {
        console.error(`Error: directory not found: ${outDir}`);
        process.exit(1);
    }

    let manifestSignatureIdentity;
    if (secretKey) {
        manifestSignatureIdentity = deriveIdentity(secretKey);
    } else {
        console.warn('Warning: no secret key provided — manifest will be unsigned');
    }

    const scriptAttrs = noInject
        ? null
        : buildScriptAttrs({ scriptSrc, manifestUrl, manifestSignatureIdentity });

    const logger = {
        info: (msg) => console.log(msg),
        warn: (msg) => console.warn(msg),
        error: (msg) => console.error(msg),
    };

    if (!noInject) {
        console.log(
            `DappFence: script tag → ${buildScriptTag({ scriptSrc, manifestUrl, manifestSignatureIdentity })}`
        );
    }

    await generateManifest({
        outDir,
        manifestPath,
        exclude,
        secretKey,
        mode,
        scriptAttrs,
        logger,
    });
}

async function main() {
    const [, , cmd, ...rest] = process.argv;

    if (!cmd || cmd === '--help' || cmd === '-h') {
        usage();
        return;
    }

    if (cmd === 'hash') {
        cmdHash(rest);
        return;
    }

    if (cmd === 'verify') {
        cmdVerify(rest[0]);
        return;
    }

    if (cmd === 'sign') {
        const [dir, ...opts] = rest;
        const args = {};
        for (let i = 0; i < opts.length; i++) {
            if (opts[i].startsWith('--')) {
                // flags with values
                if (i + 1 < opts.length && !opts[i + 1].startsWith('--')) {
                    args[opts[i]] = opts[i + 1];
                    i++;
                } else {
                    args[opts[i]] = true;
                }
            }
        }
        await cmdSign(dir, args);
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
