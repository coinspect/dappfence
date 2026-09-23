#!/usr/bin/env node
/**
 * Update a local @dappfence tarball consumer (supports monorepos).
 *
 * Scans the consumer root package.json and all workspace members (resolved from
 * the root "workspaces" field, same simple "dir/*" patterns as sync-versions.js)
 * for file:*.tgz references to @dappfence packages. For each found reference it:
 *   1. Copies the fresh tarball from dist/ (matched by slug, deduplicated).
 *   2. Updates the file: ref in whichever package.json owned the entry.
 *   3. Patches the root package-lock.json: updates @dappfence tarball refs inside
 *      workspace member entries by slug-matching against dist/ (independent of
 *      what changed this run, so it handles pre-updated package.json files too),
 *      and removes node_modules/@dappfence/* entries for clean reinstall.
 *
 * Usage:
 *   node scripts/update-local-consumer.js <consumer-dir>                      dry run
 *   node scripts/update-local-consumer.js <consumer-dir> --apply              write changes
 *   node scripts/update-local-consumer.js <consumer-dir> --apply --install    also npm install
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS_DIR, '..');
const DIST_DIR = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const install = args.includes('--install');
const consumerArg = args.find((a) => !a.startsWith('-'));

if (!consumerArg) {
    console.error(
        'Usage: node scripts/update-local-consumer.js <consumer-dir> [--apply] [--install]'
    );
    process.exit(1);
}

const consumerDir = resolve(consumerArg);
const consumerPkgPath = resolve(consumerDir, 'package.json');
const consumerLockPath = resolve(consumerDir, 'package-lock.json');

if (!existsSync(consumerPkgPath)) {
    console.error(`No package.json found at: ${consumerPkgPath}`);
    process.exit(1);
}

// Collect root + workspace member package.json paths.
// Supports the same simple "dir/*" patterns as sync-versions.js.
const rootPkg = JSON.parse(readFileSync(consumerPkgPath, 'utf8'));
const workspacePatterns = rootPkg.workspaces ?? [];
const memberPkgPaths = workspacePatterns.flatMap((pattern) => {
    const parts = pattern.split('/');
    const glob = parts.at(-1);
    const baseDir = resolve(consumerDir, ...parts.slice(0, -1)); // '' parts resolve to consumerDir
    if (glob !== '*') {
        const p = resolve(consumerDir, pattern, 'package.json');
        return existsSync(p) ? [p] : [];
    }
    return readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => resolve(baseDir, e.name, 'package.json'))
        .filter(existsSync);
});
const allPkgPaths = [consumerPkgPath, ...memberPkgPaths];

// Gather all @dappfence file:*.tgz entries across root + members.
const tgzEntries = []; // { pkgPath, pkgName, ref }
for (const pkgPath of allPkgPaths) {
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
        continue;
    }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const [pkgName, ref] of Object.entries(allDeps)) {
        if (
            pkgName.startsWith('@dappfence/') &&
            typeof ref === 'string' &&
            ref.startsWith('file:') &&
            ref.endsWith('.tgz')
        ) {
            tgzEntries.push({ pkgPath, pkgName, ref });
        }
    }
}

if (tgzEntries.length === 0) {
    console.log('No @dappfence file: tarball references found in consumer package.json files.');
    process.exit(0);
}

// Tarball name pattern: <slug>-<semver>.tgz  e.g. dappfence-astro-0.1.0.tgz
const TARBALL_RE = /^(.+)-(\d+\.\d+\.\d+(?:-.+)?)\.tgz$/;

const distFiles = readdirSync(DIST_DIR).filter((f) => f.endsWith('.tgz'));

const label = apply ? '→' : '(dry run)';

const updates = [];

for (const { pkgPath, pkgName, ref } of tgzEntries) {
    // ref is like "file:../vendor/dappfence-astro-0.1.0.tgz"
    const refPath = ref.slice('file:'.length);
    const pkgDir = dirname(pkgPath);
    const destDir = resolve(pkgDir, dirname(refPath));
    const oldFilename = refPath.split('/').at(-1); // "dappfence-astro-0.1.0.tgz"

    const match = TARBALL_RE.exec(oldFilename);
    if (!match) {
        console.warn(`  Skipping ${pkgName}: cannot parse tarball filename "${oldFilename}"`);
        continue;
    }
    const [, slug, oldVersion] = match; // slug = "dappfence-astro", oldVersion = "0.1.0"

    // Find the matching tarball in dist/ by slug prefix
    const newFilename = distFiles.find((f) => f.startsWith(slug + '-'));
    if (!newFilename) {
        console.warn(`  Skipping ${pkgName}: no tarball found in dist/ for slug "${slug}"`);
        continue;
    }

    const newVersionMatch = TARBALL_RE.exec(newFilename);
    const newVersion = newVersionMatch ? newVersionMatch[2] : '?';

    const srcPath = resolve(DIST_DIR, newFilename);
    const destPath = resolve(destDir, newFilename);
    const newRef = ref.replace(oldFilename, newFilename);

    console.log(`  ${pkgName}  ${oldVersion} ${label} ${newVersion}`);
    console.log(`    copy   ${relative(ROOT, srcPath)}`);
    console.log(`      →    ${relative(ROOT, destPath)}`);
    if (oldFilename !== newFilename) {
        console.log(`    delete ${relative(ROOT, resolve(destDir, oldFilename))}`);
    }

    const oldPath = resolve(destDir, oldFilename);
    updates.push({
        pkgPath,
        pkgName,
        oldRef: ref,
        newRef,
        srcPath,
        destPath,
        oldFilename,
        oldPath,
    });
}

if (updates.length === 0) {
    console.log('Nothing to update.');
    process.exit(0);
}

if (!apply) {
    console.log('\nNo files written. Pass --apply to apply.');
    process.exit(0);
}

// Copy tarballs (deduplicated by destPath), delete old file if filename changed.
const copiedDest = new Set();
for (const { srcPath, destPath, oldPath } of updates) {
    if (!copiedDest.has(destPath)) {
        copyFileSync(srcPath, destPath);
        copiedDest.add(destPath);
    }
    if (oldPath !== destPath && existsSync(oldPath)) {
        unlinkSync(oldPath);
    }
}

// Update each package.json that had references changed, grouped by file.
const byPkgPath = new Map();
for (const { pkgPath, oldRef, newRef } of updates) {
    if (!byPkgPath.has(pkgPath)) byPkgPath.set(pkgPath, []);
    byPkgPath.get(pkgPath).push({ oldRef, newRef });
}
for (const [pkgPath, changes] of byPkgPath) {
    let raw = readFileSync(pkgPath, 'utf8');
    for (const { oldRef, newRef } of changes) {
        raw = raw.replaceAll(oldRef, newRef);
    }
    writeFileSync(pkgPath, raw);
    console.log(`\nUpdated ${relative(consumerDir, pkgPath)}`);
}

// Clean stale @dappfence entries from package-lock.json.
// Two passes:
//   1. Update any file:*.tgz ref for an @dappfence package inside workspace entries'
//      dep fields — resolved by slug against the current dist/ tarballs, not just
//      the set of refs that changed. This handles the case where some package.json
//      files were already updated before this script ran.
//   2. Delete node_modules/@dappfence/* entries so they get reinstalled from the new tarballs.
if (existsSync(consumerLockPath)) {
    const lock = JSON.parse(readFileSync(consumerLockPath, 'utf8'));
    let patched = 0;
    let removed = 0;

    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        if (key.includes('node_modules/@dappfence')) {
            delete lock.packages[key];
            removed++;
            continue;
        }
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
            const deps = entry[field];
            if (!deps) continue;
            for (const [depName, depRef] of Object.entries(deps)) {
                if (
                    !depName.startsWith('@dappfence/') ||
                    typeof depRef !== 'string' ||
                    !depRef.startsWith('file:') ||
                    !depRef.endsWith('.tgz')
                ) {
                    continue;
                }
                const oldFilename = depRef.split('/').at(-1);
                const slugMatch = TARBALL_RE.exec(oldFilename);
                if (!slugMatch) continue;
                const slug = slugMatch[1];
                const newFilename = distFiles.find((f) => f.startsWith(slug + '-'));
                if (!newFilename || newFilename === oldFilename) continue;
                deps[depName] = depRef.replace(oldFilename, newFilename);
                patched++;
            }
        }
    }

    writeFileSync(consumerLockPath, JSON.stringify(lock, null, 2) + '\n');
    console.log(
        `Updated ${patched} @dappfence ref(s) and removed ${removed} node_modules entries from package-lock.json`
    );
}

// npm install
if (install) {
    console.log('\nRunning npm install...');
    const result = spawnSync('npm', ['install'], {
        cwd: consumerDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    // Lock integrity check
    console.log('\nRunning lock integrity check...');
    const checkScript = resolve(SCRIPTS_DIR, 'check-lock-integrity.js');
    const check = spawnSync('node', [checkScript, consumerDir], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    process.exit(check.status ?? 0);
}

console.log('\nDone. Run npm install in the consumer directory to finish.');
