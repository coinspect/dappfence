#!/usr/bin/env node
/**
 * dappfence-next — postbuild CLI for Next.js static export (output: 'export').
 *
 * Reads the config written by the webpack plugin during `next build`, then:
 *   1. Copies dappfence.js into the export output directory.
 *   2. Injects the dappfence script tag into every HTML file.
 *   3. Hashes all tracked files and writes a signed integrity-manifest.json.
 *
 * Add to package.json:
 *   "scripts": {
 *     "build": "next build",
 *     "postbuild": "dappfence-next"
 *   }
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const { generateManifest } = _require('@dappfence/manifest-tools/manifest');
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

async function main() {
    const configPath = path.join(process.cwd(), '.next', 'dappfence-config.json');

    let opts;
    try {
        opts = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch {
        console.error(
            'DappFence: could not read .next/dappfence-config.json — ' +
                'make sure withDappfence() is configured in next.config.js and next build has run.'
        );
        process.exit(1);
    }

    // Next.js static export writes to out/ by default.
    const outDir = path.join(process.cwd(), opts.distDir || 'out');

    const outDirExists = await fs
        .stat(outDir)
        .then(() => true)
        .catch(() => false);
    if (!outDirExists) {
        console.error(`DappFence: output directory not found: ${outDir}`);
        process.exit(1);
    }

    // Copy dappfence.js into the output directory.
    const destRel = opts.scriptSrc.replace(/^\//, '');
    const destAbs = path.join(outDir, destRel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
    console.log(`DappFence: copied dappfence.js → ${destRel}`);

    const logger = {
        info: (msg) => console.log(msg),
        warn: (msg) => console.warn(msg),
        error: (msg) => console.error(msg),
    };

    await generateManifest({
        outDir,
        manifestPath: opts.manifestPath,
        extensions: opts.extensions,
        exclude: opts.exclude,
        secretKey: opts.secretKey,
        mode: opts.mode,
        scriptAttrs: opts,
        logger,
    });
}

main().catch((err) => {
    console.error('DappFence:', err.message);
    process.exit(1);
});
