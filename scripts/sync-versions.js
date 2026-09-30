#!/usr/bin/env node
/**
 * Version management for the packages this repo actually publishes.
 *
 * Policy: MAJOR.MINOR is synced across every publishable package (they ship as one
 * generation); PATCH moves independently per package (a single-package bugfix doesn't
 * need to drag every other package's version along). There is no single "the version of
 * DappFence" beyond the shared MAJOR.MINOR line.
 *
 * The list of publishable packages is the explicit allowlist in packages/publish.json, not
 * derived from a `private` field — a new package in packages/ is never auto-enrolled into
 * releases just by existing there.
 *
 * Usage:
 *   node scripts/sync-versions.js                              list current versions
 *   node scripts/sync-versions.js check                        verify MAJOR.MINOR matches everywhere (used by CI)
 *   node scripts/sync-versions.js bump-major-minor <X.Y>        preview a MAJOR.MINOR bump (dry run)
 *   node scripts/sync-versions.js bump-major-minor <X.Y> --apply   apply it (resets every PATCH to 0)
 *   node scripts/sync-versions.js bump-patch <pkg-name>         preview a PATCH+1 bump for one package
 *   node scripts/sync-versions.js bump-patch <pkg-name> --apply    apply it
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Explicit allowlist, by directory name under packages/ — every publishable package lives
// there, so only the name is stored, not the full path. Adding a new package to packages/
// does NOT make it publishable — it has to be added to packages/publish.json on purpose.
export const PUBLISHABLE_PACKAGES = JSON.parse(
    readFileSync(resolve(ROOT, 'packages', 'publish.json'), 'utf8')
);
export const PUBLISHABLE_PACKAGE_DIRS = PUBLISHABLE_PACKAGES.map((name) => `packages/${name}`);

// Everything below only runs when this file is executed directly (not when
// imported, e.g. by CI to read PUBLISHABLE_PACKAGE_DIRS without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    await main();
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const command = args[0];

    const packages = PUBLISHABLE_PACKAGE_DIRS.map((rel) => {
        const pkgPath = resolve(ROOT, rel, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return { rel, pkgPath, pkg };
    });

    function majorMinor(version) {
        const [major, minor] = version.split('.');
        return `${major}.${minor}`;
    }

    function cmpMajorMinor(a, b) {
        const [aMaj, aMin] = a.split('.').map(Number);
        const [bMaj, bMin] = b.split('.').map(Number);
        return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
    }

    async function existsOnRegistry(name, version) {
        const res = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
        );
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        throw new Error(`registry check for ${name}@${version} failed — HTTP ${res.status}`);
    }

    function listCommand() {
        console.log('Publishable packages:\n');
        for (const { pkg } of packages) {
            console.log(`  ${pkg.name}  ${pkg.version}`);
        }
    }

    function checkCommand() {
        const lines = new Set(packages.map(({ pkg }) => majorMinor(pkg.version)));
        if (lines.size > 1) {
            console.error(
                'sync-versions check: publishable packages are on mismatched MAJOR.MINOR lines:'
            );
            for (const { pkg } of packages) {
                console.error(`  ${pkg.name}  ${pkg.version}  (${majorMinor(pkg.version)})`);
            }
            console.error('\nFix: node scripts/sync-versions.js bump-major-minor <X.Y> --apply');
            process.exit(1);
        }
        console.log(`OK — every publishable package is on the ${[...lines][0]} line.`);
    }

    async function bumpMajorMinorCommand(target) {
        if (!target || !/^\d+\.\d+$/.test(target)) {
            console.error('Usage: node scripts/sync-versions.js bump-major-minor <X.Y> [--apply]');
            process.exit(1);
        }
        for (const { pkg } of packages) {
            if (cmpMajorMinor(target, majorMinor(pkg.version)) <= 0) {
                console.error(
                    `sync-versions: target ${target} is not greater than current ${pkg.name}@${pkg.version} (${majorMinor(pkg.version)}).`
                );
                process.exit(1);
            }
        }
        const targetVersion = `${target}.0`;
        if (apply) {
            for (const { pkg } of packages) {
                if (await existsOnRegistry(pkg.name, targetVersion)) {
                    console.error(
                        `sync-versions: ${pkg.name}@${targetVersion} already exists on npm — cannot reuse.`
                    );
                    process.exit(1);
                }
            }
        }
        console.log(
            apply
                ? `Bumping every publishable package to ${targetVersion}:\n`
                : `Dry run — would bump every publishable package to ${targetVersion}:\n`
        );
        for (const { pkgPath, pkg } of packages) {
            console.log(
                `  ${pkg.name}  ${pkg.version} ${apply ? '→' : '(dry run)'} ${targetVersion}`
            );
            if (apply) {
                pkg.version = targetVersion;
                writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
            }
        }
        console.log(
            apply
                ? '\nDone. Commit the bump, then tag and push to release.'
                : '\nNo files written. Pass --apply to apply.'
        );
    }

    async function bumpPatchCommand(name) {
        if (!name) {
            console.error(
                'Usage: node scripts/sync-versions.js bump-patch <package-name> [--apply]'
            );
            process.exit(1);
        }
        const entry = packages.find(({ pkg }) => pkg.name === name);
        if (!entry) {
            console.error(
                `sync-versions: "${name}" is not a publishable package. Publishable packages:`
            );
            for (const { pkg } of packages) console.error(`  ${pkg.name}`);
            process.exit(1);
        }
        const { pkgPath, pkg } = entry;
        const [major, minor, patch] = pkg.version.split('.');
        const targetVersion = `${major}.${minor}.${Number(patch) + 1}`;
        if (apply && (await existsOnRegistry(pkg.name, targetVersion))) {
            console.error(
                `sync-versions: ${pkg.name}@${targetVersion} already exists on npm — cannot reuse.`
            );
            process.exit(1);
        }
        console.log(`  ${pkg.name}  ${pkg.version} ${apply ? '→' : '(dry run)'} ${targetVersion}`);
        if (apply) {
            pkg.version = targetVersion;
            writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
            console.log('\nDone. Commit the bump, then tag and push to release.');
        } else {
            console.log('\nNo files written. Pass --apply to apply.');
        }
    }

    switch (command) {
        case undefined:
            listCommand();
            break;
        case 'check':
            checkCommand();
            break;
        case 'bump-major-minor':
            await bumpMajorMinorCommand(args[1]);
            break;
        case 'bump-patch':
            await bumpPatchCommand(args[1]);
            break;
        default:
            console.error(`Unknown command "${command}". See the header comment for usage.`);
            process.exit(1);
    }
}
