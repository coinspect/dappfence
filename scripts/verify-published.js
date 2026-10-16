#!/usr/bin/env node
/**
 * Rebuilds the publishable packages and checks the result against what is on npm.
 *
 * npm provenance already attests that a tarball came from this repository and commit. This
 * proves the stronger claim: that the bytes on the registry correspond to source you can read,
 * trusting nothing but your own machine. The attestation's role here is only to name the
 * commit -- if it named the wrong one, the rebuild would not match, so the comparison
 * validates the attestation as a side effect rather than requiring it to be trusted.
 *
 * Four of the five packages ship raw committed source, so for them `npm pack` is a plain
 * archive of files already in git and nothing can drift. Only @dappfence/core is built, and
 * only it depends on the toolchain -- including the platform, since npm resolves the
 * @rollup/* and @esbuild/* native binaries by platform at install time. Checking core
 * therefore requires linux x64, or the pinned image from .github/build-image; the other four
 * can be checked anywhere with --package.
 *
 * Usage:
 *   node scripts/verify-published.js                     verify every publishable package
 *   node scripts/verify-published.js --package <name>    verify one
 *   node scripts/verify-published.js --version <x.y.z>   override the version to check
 *
 * Run it from a checkout of the commit the release was built from. The script says which
 * commit that is and refuses to continue from anywhere else.
 */
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { PUBLISHABLE_PACKAGE_DIRS } from './sync-versions.js';

const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);

function argValue(name) {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

const onlyPackage = argValue('--package');
const versionOverride = argValue('--version');

const problems = [];
const checked = [];

function sh(cmd, cmdArgs, opts = {}) {
    return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

// The attestation's subject digest is hex; npm's dist.integrity is base64. Comparing the two
// encodings directly reports a spurious mismatch, so everything here is hex.
function sha512(buf) {
    return createHash('sha512').update(buf).digest('hex');
}

/**
 * Explicit status triage rather than res.ok, matching scripts/sync-versions.js.
 */
async function getJson(url) {
    const res = await fetch(url);
    if (res.status === 200) return { state: 'ok', body: await res.json() };
    if (res.status === 404) return { state: 'absent' };
    throw new Error(`GET ${url} failed — HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------

/**
 * A toolchain mismatch makes a "differs" result uninterpretable -- you would not know whether
 * the package was tampered with or you simply built it with the wrong compiler. So this fails
 * rather than warning.
 *
 * The platform is part of the toolchain, not separate from it. package-lock.json pins the
 * version and integrity of all 26 @esbuild/* and 25 @rollup/rollup-* packages but not *which*
 * one installs -- npm picks that by platform at install time -- and both are on the critical
 * path for @dappfence/core's bundle. So the same source on macOS arm64 and on CI's linux x64
 * produces different bytes, and without this check a maintainer on an Apple laptop gets a
 * mismatch and a report telling them to treat it as a supply-chain incident. That false alarm
 * would land on exactly the people most likely to run this script.
 */
function checkToolchain(packages) {
    // Only @dappfence/core is built; the other four pack committed source, which is identical
    // everywhere. Scoping the check keeps `--package @dappfence/astro` usable off-platform.
    const buildsCore = packages.some(({ name }) => name === '@dappfence/core');
    if (buildsCore && (process.platform !== 'linux' || process.arch !== 'x64')) {
        problems.push(
            `toolchain: this is ${process.platform} ${process.arch}, but @dappfence/core is\n` +
                `      built on linux x64 (see .github/build-image). Its bundle depends on which\n` +
                `      @rollup/* and @esbuild/* native binaries npm installed, so a rebuild here\n` +
                `      cannot match and a "differs" result would mean nothing.\n\n` +
                `      Rebuild in the pinned image, the same one releases are built in:\n` +
                `        docker run --rm --platform linux/amd64 -v "$PWD:/src:ro" \\\n` +
                `          "$(cat .github/build-image)" bash -euo pipefail -c '\n` +
                `            git config --global --add safe.directory /src\n` +
                `            git clone -q /src /v && cd /v\n` +
                `            npm ci -s && npm run verify-published\n` +
                `          '\n` +
                `      (if the image ships a different npm than package.json pins, the run says\n` +
                `      so and gives the install command -- the check below this one.)\n\n` +
                `      Or check the four source-only packages alone, which are platform-\n` +
                `      independent: --package @dappfence/astro`
        );
    }

    const wantNode = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
    const haveNode = process.versions.node;
    if (haveNode !== wantNode) {
        problems.push(
            `toolchain: running Node ${haveNode}, but .nvmrc pins ${wantNode}. ` +
                `Switch with "nvm use" (or your version manager) and re-run`
        );
    }

    const declared = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).packageManager;
    const wantNpm = String(declared ?? '').replace(/^npm@/, '');
    const haveNpm = sh('npm', ['--version']);
    if (wantNpm && haveNpm !== wantNpm) {
        problems.push(
            `toolchain: running npm ${haveNpm}, but package.json pins ${wantNpm}. ` +
                `Install it with "npm install -g npm@${wantNpm}" and re-run`
        );
    }

    if (problems.length === 0) {
        checked.push(
            `toolchain: node ${haveNode}, npm ${haveNpm}, ${process.platform} ${process.arch}`
        );
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Pulls the source commit and the expected tarball digest out of npm's SLSA provenance
 * attestation. Both live in the DSSE payload, which is base64 inside the bundle.
 *
 * Returns a state rather than a bare object, because "no attestation" and "an attestation
 * missing the fields this script checks" need different messages: the first is usually a
 * version published before provenance existed, the second is never normal.
 */
async function attestation(name, version) {
    const url = `${REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
    const res = await getJson(url);
    if (res.state !== 'ok') return { state: 'absent' };

    const bundle = (res.body.attestations ?? []).find((a) =>
        /slsa\.dev\/provenance/.test(a.predicateType ?? '')
    );
    if (!bundle?.bundle?.dsseEnvelope?.payload) return { state: 'absent' };

    const payload = JSON.parse(
        Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
    );
    const build = payload.predicate?.buildDefinition ?? {};
    const commit = build.resolvedDependencies?.[0]?.digest?.gitCommit;
    const subjectSha512 = payload.subject?.[0]?.digest?.sha512;

    // Both checks that consume these are written as `if (value && value !== expected)`, so a
    // missing field would skip the comparison while the run still reported "matches the
    // attestation". Refuse the attestation instead: an absent field must never read as a
    // satisfied one. `workflow` is informational only and may legitimately be absent.
    if (!commit || !subjectSha512) return { state: 'malformed' };

    return { state: 'ok', commit, subjectSha512, workflow: build.externalParameters?.workflow };
}

async function fetchTarball(name, version) {
    const res = await getJson(`${REGISTRY}/${encodeURIComponent(name)}/${version}`);
    if (res.state !== 'ok') return null;
    const url = res.body.dist?.tarball;
    if (!url) return null;
    const tgz = await fetch(url);
    if (tgz.status !== 200) throw new Error(`GET ${url} failed — HTTP ${tgz.status}`);
    return Buffer.from(await tgz.arrayBuffer());
}

// ---------------------------------------------------------------------------

function localPackages() {
    return PUBLISHABLE_PACKAGE_DIRS.map((rel) => {
        const pkg = JSON.parse(readFileSync(resolve(ROOT, rel, 'package.json'), 'utf8'));
        return { rel, name: pkg.name, version: versionOverride ?? pkg.version };
    }).filter(({ name }) => !onlyPackage || name === onlyPackage);
}

/**
 * Mirrors the build job in .github/workflows/release.yml exactly. Any divergence here --
 * a missing rm -rf, a different COMMIT_HASH, scripts left enabled -- produces a mismatch
 * that looks like tampering but is only this script being wrong.
 */
function rebuildAndPack(packages, outDir) {
    const short = sh('git', ['rev-parse', '--short=7', 'HEAD']);

    if (packages.some(({ name }) => name === '@dappfence/core')) {
        rmSync(resolve(ROOT, 'packages/dappfence/dist'), { recursive: true, force: true });
        sh('npm', ['run', 'build', '-w', '@dappfence/core'], {
            env: { ...process.env, COMMIT_HASH: short },
            stdio: 'pipe',
        });
    }

    for (const { rel } of packages) {
        sh('npm', ['pack', '--workspace', rel, '--pack-destination', outDir, '--ignore-scripts'], {
            stdio: 'pipe',
        });
    }
}

async function main() {
    const packages = localPackages();
    if (packages.length === 0) {
        console.error(`verify-published: no publishable package named "${onlyPackage}".`);
        process.exit(1);
    }

    // Reported before the registry is touched. These are local, cheap, and decide whether a
    // rebuild here could mean anything at all -- and the platform problem in particular would
    // otherwise be hidden behind the commit check below, which exits on its own.
    checkToolchain(packages);
    if (problems.length > 0) {
        report();
        return;
    }

    // Each package has its own attestation, carrying its own subject digest -- so they are
    // fetched per package rather than once. The commit they name should agree across a
    // release; disagreement would mean they were not built together.
    const atts = new Map();
    for (const { name, version } of packages) {
        const att = await attestation(name, version);
        if (att.state === 'absent') {
            console.error(`verify-published: no provenance attestation for ${name}@${version}.`);
            console.error(
                '\nEither that version is not published, or it was published without provenance.'
            );
            process.exit(1);
        }
        if (att.state === 'malformed') {
            console.error(
                `verify-published: the provenance attestation for ${name}@${version} does not ` +
                    'carry a source commit, a subject digest, or both.'
            );
            console.error(
                '\nThose are the two things this script verifies against, so there is nothing to\n' +
                    'check and a pass would mean nothing. Treat it as a supply-chain incident until\n' +
                    'shown otherwise: an attestation that omits what it is meant to attest to is not\n' +
                    'a normal state for a package published by this pipeline.'
            );
            process.exit(1);
        }
        atts.set(name, att);
    }

    const first = atts.get(packages[0].name);
    const head = sh('git', ['rev-parse', 'HEAD']);
    if (first.commit !== head) {
        console.error(`verify-published: this checkout is not the commit that was published.`);
        console.error(`  attested: ${first.commit}`);
        console.error(`  HEAD:     ${head}`);
        console.error(`\nFix: git checkout ${first.commit}`);
        process.exit(1);
    }
    checked.push(`commit: ${head.slice(0, 12)} matches the attestation`);
    if (first.workflow?.path) {
        checked.push(`built by: ${first.workflow.path} in ${first.workflow.repository ?? '?'}`);
    }

    for (const { name } of packages) {
        const att = atts.get(name);
        if (att.commit !== first.commit) {
            problems.push(
                `${name}: attested commit ${att.commit.slice(0, 12)} differs from ` +
                    `${first.commit.slice(0, 12)} — these packages were not built together`
            );
        }
    }

    if (problems.length > 0) {
        report();
        return;
    }

    const outDir = mkdtempSync(join(tmpdir(), 'dappfence-verify-'));
    try {
        rebuildAndPack(packages, outDir);
        const built = readdirSync(outDir);

        for (const { name, version } of packages) {
            const published = await fetchTarball(name, version);
            if (!published) {
                problems.push(`${name}@${version}: not found on the registry`);
                continue;
            }

            const file = built.find((f) => f.endsWith(`-${version}.tgz`) && matches(f, name));
            if (!file) {
                problems.push(`${name}@${version}: local pack produced no matching tarball`);
                continue;
            }

            const localDigest = sha512(readFileSync(join(outDir, file)));
            const publishedDigest = sha512(published);

            if (localDigest !== publishedDigest) {
                problems.push(
                    `${name}@${version}: rebuilt tarball does not match the published one\n` +
                        `      published: ${publishedDigest.slice(0, 32)}…\n` +
                        `      rebuilt:   ${localDigest.slice(0, 32)}…`
                );
                continue;
            }

            // Confirms the tarball the registry served is the one the attestation covers --
            // a different tarball under the same version would pass the rebuild check only
            // if it also matched our build, but this catches a mismatched attestation.
            const attested = atts.get(name).subjectSha512;
            if (attested !== publishedDigest) {
                problems.push(
                    `${name}@${version}: the registry's tarball is not the one the attestation ` +
                        `covers\n      attested:  ${attested.slice(0, 32)}…\n` +
                        `      downloaded: ${publishedDigest.slice(0, 32)}…`
                );
                continue;
            }

            checked.push(`${name}@${version}: reproduces byte-for-byte, matches attestation`);
        }
    } finally {
        rmSync(outDir, { recursive: true, force: true });
    }

    report();
}

/** npm pack names files after the package, with the scope flattened: @a/b -> a-b-1.0.0.tgz */
function matches(file, name) {
    return file.startsWith(name.replace(/^@/, '').replace('/', '-') + '-');
}

function report() {
    for (const line of checked) {
        console.log(`  ✓ ${line}`);
    }

    if (problems.length === 0) {
        console.log(`\n✓ ${checked.length} checks passed — the published packages reproduce.`);
        process.exit(0);
    }

    console.error(`\n✗ ${problems.length} problem(s):\n`);
    for (const msg of problems) {
        console.error(`  ${msg}`);
    }

    // Nothing was compared yet when the only problems are toolchain ones, so the incident
    // language below would be actively misleading -- it is the wrong machine, not a bad
    // package, and that distinction is the difference between a fix and a false alarm.
    if (!problems.every((p) => p.startsWith('toolchain:'))) {
        console.error(
            '\nA mismatch means the published bytes were not produced by this source with this\n' +
                'toolchain. Check the toolchain first. Note that versions published before the\n' +
                'build was made machine-independent cannot reproduce -- see "Verifying a published\n' +
                'release" in docs/release-setup.md for the first version that can. Otherwise, treat\n' +
                'it as a supply-chain incident.'
        );
    }
    process.exit(1);
}

await main();
