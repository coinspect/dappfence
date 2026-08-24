#!/usr/bin/env node
/**
 * Sync all workspace package versions to a single version (private and public alike).
 * The private flag only gates `npm publish`, not version syncing.
 *
 * Usage:
 *   node scripts/sync-versions.js                                list current versions
 *   node scripts/sync-versions.js <version>                      preview changes (dry run)
 *   node scripts/sync-versions.js <version> --apply              write version bumps (keep * deps)
 *   node scripts/sync-versions.js <version> --apply --pin-deps   bump + pin intra-workspace deps (CI/publish only, do not commit)
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pinDeps = args.includes('--pin-deps');
const version = args.find((a) => /^\d+\.\d+\.\d+(-\S+)?$/.test(a));

// Resolve workspace globs from root package.json.
// Supports simple "dir/*" patterns only (no brace expansion).
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const workspacePatterns = rootPkg.workspaces ?? [];

const packageJsonPaths = workspacePatterns.flatMap((pattern) => {
    const [base, glob] = pattern.split('/');
    if (glob !== '*') {
        // Non-wildcard: treat as a direct package path
        return [`${base}/package.json`];
    }
    return readdirSync(resolve(ROOT, base), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${base}/${e.name}/package.json`);
});

// All workspace packages get their version bumped (private or not).
// The private flag only gates `npm publish`, not version syncing.
const allPackages = packageJsonPaths.filter((relPath) => {
    try {
        JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
        return true;
    } catch {
        return false;
    }
});

const workspaceNames = new Set(
    allPackages.map((p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')).name)
);

if (!version) {
    console.log('Current package versions:\n');
    for (const relPath of allPackages) {
        const pkg = JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
        const tag = pkg.private ? ' (private)' : '';
        console.log(`  ${pkg.name}  ${pkg.version}${tag}`);
    }
    console.log('\nTo preview a bump:  npm run sync-versions <version>');
    console.log('To apply a bump:    npm run sync-versions <version> -- --apply');
    process.exit(0);
}

if (!apply) {
    console.log(
        `Dry run — would sync all packages to ${version}${pinDeps ? ' (with pinned deps)' : ''}:\n`
    );
} else {
    console.log(
        `Syncing all packages to ${version}${pinDeps ? ' (pinning deps — do not commit)' : ''}:\n`
    );
}

for (const relPath of allPackages) {
    const abs = resolve(ROOT, relPath);
    const pkg = JSON.parse(readFileSync(abs, 'utf8'));
    const oldVersion = pkg.version;

    const depsToPin = pinDeps
        ? Object.entries(pkg.dependencies ?? {})
              .filter(([dep, val]) => workspaceNames.has(dep) && val === '*')
              .map(([dep]) => dep)
        : [];

    const label = apply ? '→' : '(dry run)';
    console.log(`  ${pkg.name}  ${oldVersion} ${label} ${version}`);
    for (const dep of depsToPin) {
        console.log(`    dep ${dep}: * ${label} ${version}`);
    }

    if (apply) {
        pkg.version = version;
        for (const dep of depsToPin) {
            pkg.dependencies[dep] = version;
        }
        writeFileSync(abs, JSON.stringify(pkg, null, 4) + '\n');
    }
}

if (apply && pinDeps) {
    console.log(
        '\nDone. Deps pinned — publish now, then restore * with git checkout packages/*/package.json'
    );
} else {
    console.log(
        apply
            ? '\nDone. Commit the version bump before publishing.'
            : '\nNo files written. Pass --apply to apply.'
    );
}
