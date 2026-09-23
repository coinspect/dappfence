#!/usr/bin/env node
/**
 * Audits package-lock.json for supply chain security gaps:
 *   1. lockfileVersion must be >= 2 (v1 lacks per-package integrity in the packages map)
 *   2. Every registry package must have an integrity hash (missing = silent tamper bypass)
 *   3. Integrity hash must use sha512, not the deprecated sha1
 *   4. Every registry package must resolve from registry.npmjs.org (lockfile poisoning)
 *
 * Usage: node scripts/check-lock-integrity.js
 * Exit code 1 if any check fails.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const cwdArg = args.find((a) => !a.startsWith('-'));
const root = cwdArg ? resolve(cwdArg) : resolve(fileURLToPath(import.meta.url), '..', '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));

const failures = [];

// 1. lockfileVersion
if ((lock.lockfileVersion ?? 0) < 2) {
    failures.push(
        `lockfileVersion is ${lock.lockfileVersion ?? 'missing'} — must be >= 2. Run "npm install" to regenerate.`
    );
}

const packages = lock.packages ?? {};
const registryPackages = Object.entries(packages).filter(
    ([, pkg]) => typeof pkg.resolved === 'string' && pkg.resolved.startsWith('https://')
);

// 2. Missing integrity
const missingIntegrity = registryPackages.filter(([, pkg]) => !pkg.integrity);
for (const [name] of missingIntegrity) {
    failures.push(`Missing integrity hash: ${name}`);
}

// 3. Weak hash algorithm (sha1 instead of sha512)
const weakHash = registryPackages.filter(
    ([, pkg]) => pkg.integrity && !pkg.integrity.startsWith('sha512-')
);
for (const [name, pkg] of weakHash) {
    const algo = pkg.integrity.split('-')[0];
    failures.push(`Weak integrity hash (${algo}): ${name}`);
}

// 4. Non-official registry
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
const wrongRegistry = registryPackages.filter(
    ([, pkg]) => !pkg.resolved.startsWith(OFFICIAL_REGISTRY)
);
for (const [name, pkg] of wrongRegistry) {
    failures.push(`Resolved from non-official registry: ${name}  (${pkg.resolved})`);
}

if (failures.length === 0) {
    console.log(`✓ ${registryPackages.length} registry packages passed all integrity checks.`);
    process.exit(0);
} else {
    console.error(`✗ ${failures.length} integrity check(s) failed:\n`);
    for (const msg of failures) {
        console.error(`  ${msg}`);
    }
    console.error('\nRun "npm install" to regenerate the lock file with correct hashes.');
    process.exit(1);
}
