#!/usr/bin/env node
/**
 * Sync all workspace package versions to a single version (private and public alike).
 * The private flag only gates `npm publish`, not version syncing.
 *
 * Usage:
 *   node scripts/sync-versions.js                                   list current versions
 *   node scripts/sync-versions.js <version>                         preview bump (dry run)
 *   node scripts/sync-versions.js <version> --apply                 apply bump (keep * deps)
 *   node scripts/sync-versions.js --pin-only                        preview intra-workspace dep pin
 *   node scripts/sync-versions.js --pin-only --apply                pin * → current version (CI publish only, do not commit)
 *
 * A version bump runs three preconditions (all fail loudly, no --force):
 *   1. Consistency  — every publishable package must currently be at the same version.
 *   2. Local monotonicity — target must be strictly greater than every current version.
 *   3. Registry monotonicity — target must not already exist on the npm registry.
 *
 * --pin-only skips version writes; it only rewrites intra-workspace `*` deps to each
 * package's current version. Intended for CI to run inside an ephemeral workspace after
 * a parity check has confirmed package.json versions match the release tag.
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pinOnly = args.includes('--pin-only');
const version = args.find((a) => /^\d+\.\d+\.\d+(-\S+)?$/.test(a));

const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const workspacePatterns = rootPkg.workspaces ?? [];

const packageJsonPaths = workspacePatterns.flatMap((pattern) => {
    const [base, glob] = pattern.split('/');
    if (glob !== '*') {
        return [`${base}/package.json`];
    }
    return readdirSync(resolve(ROOT, base), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${base}/${e.name}/package.json`);
});

const allPackages = packageJsonPaths
    .map((rel) => {
        try {
            const pkg = JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
            return { rel, pkg };
        } catch {
            return null;
        }
    })
    .filter(Boolean);

const workspaceNames = new Set(allPackages.map(({ pkg }) => pkg.name));

if (!version && !pinOnly) {
    console.log('Current package versions:\n');
    for (const { pkg } of allPackages) {
        const tag = pkg.private ? ' (private)' : '';
        console.log(`  ${pkg.name}  ${pkg.version}${tag}`);
    }
    console.log('\nTo preview a bump:  npm run sync-versions <version>');
    console.log('To apply a bump:    npm run sync-versions <version> -- --apply');
    process.exit(0);
}

if (pinOnly) {
    runPinOnly();
} else {
    await runBump();
}

async function runBump() {
    await checkPreconditions(version, allPackages);

    console.log(
        apply
            ? `Syncing all packages to ${version}:\n`
            : `Dry run — would sync all packages to ${version}:\n`
    );

    for (const { rel, pkg } of allPackages) {
        console.log(`  ${pkg.name}  ${pkg.version} ${apply ? '→' : '(dry run)'} ${version}`);
        if (apply) {
            pkg.version = version;
            writeFileSync(resolve(ROOT, rel), JSON.stringify(pkg, null, 4) + '\n');
        }
    }

    console.log(
        apply
            ? '\nDone. Commit the version bump before tagging.'
            : '\nNo files written. Pass --apply to apply.'
    );
}

function runPinOnly() {
    console.log(
        apply
            ? 'Pinning intra-workspace deps to current versions (do not commit):\n'
            : 'Dry run — would pin intra-workspace deps to current versions:\n'
    );

    for (const { rel, pkg } of allPackages) {
        const depsToPin = Object.entries(pkg.dependencies ?? {})
            .filter(([dep, val]) => workspaceNames.has(dep) && val === '*')
            .map(([dep]) => dep);
        if (depsToPin.length === 0) {
            continue;
        }
        console.log(`  ${pkg.name}`);
        for (const dep of depsToPin) {
            const depVersion = allPackages.find(({ pkg: p }) => p.name === dep).pkg.version;
            console.log(`    ${dep}: * ${apply ? '→' : '(dry run)'} ${depVersion}`);
            if (apply) {
                pkg.dependencies[dep] = depVersion;
            }
        }
        if (apply) {
            writeFileSync(resolve(ROOT, rel), JSON.stringify(pkg, null, 4) + '\n');
        }
    }
    console.log(
        apply
            ? '\nDone. Publish now, then discard the workspace (do not commit).'
            : '\nNo files written. Pass --apply to apply.'
    );
}

async function checkPreconditions(target, pkgs) {
    const publishable = pkgs.filter(({ pkg }) => !pkg.private);

    // 1. Consistency
    const distinctVersions = new Set(publishable.map(({ pkg }) => pkg.version));
    if (distinctVersions.size > 1) {
        console.error('sync-versions: publishable packages are at mismatched versions:');
        for (const { pkg } of publishable) {
            console.error(`  ${pkg.name}  ${pkg.version}`);
        }
        console.error('Fix by running sync-versions with the intended version first.');
        process.exit(1);
    }

    // 2. Local monotonicity
    for (const { pkg } of publishable) {
        if (cmpVersion(target, pkg.version) <= 0) {
            console.error(
                `sync-versions: target ${target} is not greater than current ${pkg.name}@${pkg.version}.`
            );
            process.exit(1);
        }
    }

    // 3. Registry monotonicity (skip if network unavailable — CI will re-check)
    if (!apply) {
        return;
    }
    for (const { pkg } of publishable) {
        try {
            const res = await fetch(
                `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(target)}`
            );
            if (res.status === 200) {
                console.error(
                    `sync-versions: ${pkg.name}@${target} already exists on npm — cannot republish (immutability).`
                );
                process.exit(1);
            }
            if (res.status !== 404) {
                console.error(
                    `sync-versions: could not check ${pkg.name}@${target} on npm — HTTP ${res.status}. Proceed manually if you are sure.`
                );
                process.exit(1);
            }
        } catch (err) {
            console.error(
                `sync-versions: registry check for ${pkg.name} failed (${err.message}). Proceed manually if you are sure.`
            );
            process.exit(1);
        }
    }
}

function cmpVersion(a, b) {
    const [ha, pa = ''] = a.split('-', 2);
    const [hb, pb = ''] = b.split('-', 2);
    const na = ha.split('.').map(Number);
    const nb = hb.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (na[i] !== nb[i]) {
            return na[i] - nb[i];
        }
    }
    if (!pa && pb) {
        return 1;
    }
    if (pa && !pb) {
        return -1;
    }
    return pa.localeCompare(pb);
}
