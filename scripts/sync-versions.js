#!/usr/bin/env node
/**
 * Version management for the packages this repo actually publishes.
 *
 * Policy: MAJOR.MINOR is synced across every publishable package (they ship as one
 * generation); PATCH moves independently per package (a single-package bugfix doesn't
 * need to drag every other package's version along). There is no single "the version of
 * DappFence" beyond the shared MAJOR.MINOR line. Versions are plain X.Y.Z only —
 * prerelease/build metadata is rejected, because the release pipeline has no dist-tag
 * support and would publish such a version to `latest` as if it were stable.
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

    // Names of the packages that depend on each other inside this repo.
    const publishableNames = new Set(packages.map(({ pkg }) => pkg.name));

    // The range a publishable package uses for another one: "~X.Y.0" — any release from the
    // same MAJOR.MINOR generation. That is the policy stated as a semver range, and it is
    // what a consumer installing from npm actually gets to see; "*" published nothing at all
    // about which versions belong together, so an old integration would happily resolve
    // against a future, incompatible core.
    //
    // Pinned to .0 rather than to the current PATCH deliberately: PATCH moves independently,
    // so raising the floor every time core patches would force republishing every
    // integration to match. This range only changes on a MAJOR.MINOR bump.
    function depRange(majorMinorLine) {
        return `~${majorMinorLine}.0`;
    }

    // Returns [{ pkg, dep, actual, expected }] for every cross-package range that doesn't
    // match the line it should be on.
    function mismatchedRanges(line) {
        const want = depRange(line);
        const out = [];
        for (const { pkg } of packages) {
            for (const [dep, actual] of Object.entries(pkg.dependencies ?? {})) {
                if (publishableNames.has(dep) && actual !== want) {
                    out.push({ pkg, dep, actual, expected: want });
                }
            }
        }
        return out;
    }

    // Plain X.Y.Z only — no prerelease or build metadata. The release pipeline has no
    // dist-tag support (it always publishes to `latest`), so a prerelease version here
    // would publish as if it were stable. Rejecting it is the honest behavior until
    // prereleases are actually designed for; silently mangling it is not, which is what
    // the naive split('.') below used to do — "0.2.0-alpha.1" bumped to "0.2.NaN".
    const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

    function parseVersion(name, version) {
        const match = VERSION_RE.exec(version);
        if (!match) {
            console.error(
                `sync-versions: ${name} has version "${version}", which is not a plain MAJOR.MINOR.PATCH version.`
            );
            console.error(
                'Only plain X.Y.Z versions are supported (no prerelease or build metadata, no leading zeros).'
            );
            process.exit(1);
        }
        return match.slice(1, 4).map(Number);
    }

    function majorMinor(version) {
        const [major, minor] = version.split('.');
        return `${major}.${minor}`;
    }

    function cmpMajorMinor(a, b) {
        const [aMaj, aMin] = a.split('.').map(Number);
        const [bMaj, bMin] = b.split('.').map(Number);
        return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
    }

    function cmpVersion(a, b) {
        return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    }

    async function existsOnRegistry(name, version) {
        const res = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
        );
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        throw new Error(`registry check for ${name}@${version} failed — HTTP ${res.status}`);
    }

    // The version the `latest` dist-tag currently points at, or null if the package has
    // never been published. null is the expected answer for a first release.
    async function registryLatest(name) {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
        if (res.status === 404) return null;
        if (res.status !== 200) {
            throw new Error(`registry lookup for ${name} failed — HTTP ${res.status}`);
        }
        const packument = await res.json();
        return packument['dist-tags']?.latest ?? null;
    }

    // `npm publish` without --tag points `latest` at whatever it just uploaded, regardless
    // of whether that version is higher than the current one. So "this exact version is
    // unused" is NOT enough to make a release safe: a stale or reverted manifest can pick an
    // unused version that is *lower* than what's live (registry at 0.1.2, manifest at 0.1.0,
    // bump-patch offers an unused 0.1.1) and publishing it would silently move `latest`
    // backward for every consumer. Refuse anything that isn't strictly greater.
    async function assertAheadOfRegistry(name, target) {
        const latest = await registryLatest(name);
        if (latest === null) return;
        const latestParts = parseVersion(`${name} (registry \`latest\`)`, latest);
        if (cmpVersion(parseVersion(name, target), latestParts) <= 0) {
            console.error(
                `sync-versions: ${name}@${target} is not ahead of the published ${name}@${latest}.`
            );
            console.error(
                "Publishing it would move npm's `latest` tag backward. Your checked-out versions are\n" +
                    'probably behind the registry — pull main and re-run.'
            );
            process.exit(1);
        }
    }

    function listCommand() {
        console.log('Publishable packages:\n');
        for (const { pkg } of packages) {
            console.log(`  ${pkg.name}  ${pkg.version}`);
        }
    }

    function checkCommand() {
        // Validate shape before comparing lines — CI runs this against the tagged commit,
        // so it's the gate that catches a hand-edited or otherwise malformed version
        // before anything gets published under it.
        for (const { pkg } of packages) parseVersion(pkg.name, pkg.version);
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
        const line = [...lines][0];

        // Stale cross-package ranges are worse than no range at all: a 0.2 integration
        // still asking for ~0.1.0 would resolve against the previous generation's core on
        // every fresh install. CI runs this against the tagged commit, so it is the gate
        // that catches a forgotten or hand-edited range before it ships.
        const bad = mismatchedRanges(line);
        if (bad.length > 0) {
            console.error(
                `sync-versions check: cross-package dependency ranges don't match the ${line} line:`
            );
            for (const { pkg, dep, actual, expected } of bad) {
                console.error(`  ${pkg.name} -> ${dep}: "${actual}" (expected "${expected}")`);
            }
            console.error(`\nFix: node scripts/sync-versions.js bump-major-minor ${line} --apply`);
            process.exit(1);
        }
        console.log(
            `OK — every publishable package is on the ${line} line, and every cross-package range is "${depRange(line)}".`
        );
    }

    async function bumpMajorMinorCommand(target) {
        if (!target || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target)) {
            console.error('Usage: node scripts/sync-versions.js bump-major-minor <X.Y> [--apply]');
            process.exit(1);
        }
        for (const { pkg } of packages) {
            parseVersion(pkg.name, pkg.version);
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
                await assertAheadOfRegistry(pkg.name, targetVersion);
            }
        }
        console.log(
            apply
                ? `Bumping every publishable package to ${targetVersion}:\n`
                : `Dry run — would bump every publishable package to ${targetVersion}:\n`
        );
        const range = depRange(target);
        for (const { pkgPath, pkg } of packages) {
            console.log(
                `  ${pkg.name}  ${pkg.version} ${apply ? '→' : '(dry run)'} ${targetVersion}`
            );
            // The cross-package ranges move with the line. Leaving them behind would point
            // the new generation's packages at the old generation's core.
            for (const [dep, actual] of Object.entries(pkg.dependencies ?? {})) {
                if (publishableNames.has(dep) && actual !== range) {
                    console.log(
                        `      ${dep}: "${actual}" ${apply ? '→' : '(dry run)'} "${range}"`
                    );
                    if (apply) pkg.dependencies[dep] = range;
                }
            }
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
        const [major, minor, patch] = parseVersion(pkg.name, pkg.version);
        const targetVersion = `${major}.${minor}.${patch + 1}`;
        if (apply) {
            if (await existsOnRegistry(pkg.name, targetVersion)) {
                console.error(
                    `sync-versions: ${pkg.name}@${targetVersion} already exists on npm — cannot reuse.`
                );
                process.exit(1);
            }
            await assertAheadOfRegistry(pkg.name, targetVersion);
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
