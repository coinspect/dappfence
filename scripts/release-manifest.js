#!/usr/bin/env node
/**
 * Per-file hashes of the release artifacts, signed into the tag and re-checked by CI.
 *
 * The maintainer builds, packs and hashes every file, then signs that manifest into the
 * annotated tag. release.yml rebuilds, recomputes the hashes, and refuses to publish if any
 * file differs. The tag therefore stops authorizing "whatever is at this commit" and starts
 * authorizing specific bytes, agreed independently by two machines.
 *
 * Generation and checking live in one file deliberately: if they ever hashed differently,
 * every release would fail.
 *
 * Hashes cover the files *inside* each tarball, never the .tgz itself. npm normalizes tar
 * metadata, but gzip output can still vary with the zlib bundled in Node, so an archive-level
 * hash is fragile where per-file content hashes are not.
 *
 * Usage:
 *   node scripts/release-manifest.js generate [--out <file>]
 *       build, pack and hash. Writes release-manifest.txt by default.
 *
 *   node scripts/release-manifest.js check --manifest <file> --tarballs <dir> [--commit <sha>]
 *       hash the tarballs in <dir> and compare against <file>. Exits 1 on any difference.
 *
 * `generate` must run in the same environment the release builds in -- see .github/build-image.
 * Different platforms load different @rollup/* and @esbuild/* native binaries, which are on the
 * critical path for the bundle, so building elsewhere produces different bytes.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { PUBLISHABLE_PACKAGE_DIRS } from './sync-versions.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'dappfence-release-manifest v1';

const args = process.argv.slice(2);
const command = args[0];

function argValue(name) {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

function sh(cmd, cmdArgs, opts = {}) {
    return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Unpacks one tarball and hashes every file inside it. npm puts everything under `package/`,
 * which is stripped so paths read as the consumer sees them.
 *
 * Paths are normalised to forward slashes and sorted, so the manifest is identical regardless
 * of filesystem enumeration order or platform separator.
 */
function hashTarball(tgz) {
    const tmp = mkdtempSync(join(tmpdir(), 'dappfence-manifest-'));
    try {
        sh('tar', ['-xzf', resolve(tgz), '-C', tmp]);
        const base = join(tmp, 'package');
        if (!statSync(base).isDirectory()) throw new Error(`${tgz}: no package/ directory`);

        const meta = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
        const files = walk(base)
            .map((f) => ({
                path: relative(base, f).split(sep).join('/'),
                hash: sha256(readFileSync(f)),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

        return { name: meta.name, version: meta.version, files };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

function hashAll(tarballs) {
    return tarballs
        .map(hashTarball)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function render(commit, packages) {
    const lines = [FORMAT, `commit ${commit}`, ''];
    for (const pkg of packages) {
        lines.push(`${pkg.name} ${pkg.version}`);
        for (const f of pkg.files) lines.push(`  ${f.hash}  ${f.path}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Parses rather than diffs raw text. `git tag -F` defaults to --cleanup=strip, which collapses
 * blank lines and trims whitespace, so the tag's copy of the manifest is not guaranteed to be
 * byte-identical to the file that was signed. Comparing parsed entries is correct either way;
 * comparing text would fail whenever someone forgot --cleanup=verbatim.
 */
function parse(text) {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== FORMAT) {
        throw new Error(`not a release manifest -- expected a first line of "${FORMAT}"`);
    }

    let commit;
    const packages = [];
    let current;

    for (const raw of lines.slice(1)) {
        const line = raw.trimEnd();
        if (line.trim() === '') continue;

        const commitMatch = /^commit ([0-9a-f]{40})$/.exec(line);
        if (commitMatch) {
            commit = commitMatch[1];
            continue;
        }

        const fileMatch = /^\s+([0-9a-f]{64})\s{2}(.+)$/.exec(line);
        if (fileMatch) {
            if (!current) throw new Error(`file entry before any package heading: "${line}"`);
            current.files.push({ hash: fileMatch[1], path: fileMatch[2] });
            continue;
        }

        const pkgMatch = /^(\S+) (\S+)$/.exec(line);
        if (pkgMatch) {
            current = { name: pkgMatch[1], version: pkgMatch[2], files: [] };
            packages.push(current);
            continue;
        }

        throw new Error(`unparseable manifest line: "${line}"`);
    }

    if (!commit) throw new Error('manifest has no "commit <sha>" line');
    return { commit, packages };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Mirrors the build job in .github/workflows/release.yml. Divergence here produces a mismatch
 * that looks like tampering but is only this script being wrong, so the two must be kept in
 * step: clear core's dist, build it with COMMIT_HASH, pack every package with scripts off.
 */
function buildAndPack(outDir) {
    const short = sh('git', ['rev-parse', '--short=7', 'HEAD']);
    rmSync(resolve(ROOT, 'packages/dappfence/dist'), { recursive: true, force: true });
    sh('npm', ['run', 'build', '-w', '@dappfence/core'], {
        env: { ...process.env, COMMIT_HASH: short },
        stdio: 'pipe',
    });
    for (const rel of PUBLISHABLE_PACKAGE_DIRS) {
        sh('npm', ['pack', '--workspace', rel, '--pack-destination', outDir, '--ignore-scripts'], {
            stdio: 'pipe',
        });
    }
    return readdirSync(outDir)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(outDir, f));
}

function generateCommand() {
    if (sh('git', ['status', '--porcelain']) !== '') {
        console.error('release-manifest: the working tree has uncommitted changes.');
        console.error('\nThe manifest describes a specific commit, so it must be built from a');
        console.error('clean checkout. Commit or stash first.');
        process.exit(1);
    }

    const out = resolve(ROOT, argValue('--out') ?? 'release-manifest.txt');
    const staging = mkdtempSync(join(tmpdir(), 'dappfence-pack-'));
    try {
        const packages = hashAll(buildAndPack(staging));
        const commit = sh('git', ['rev-parse', 'HEAD']);
        const text = render(commit, packages);
        writeFileSync(out, text);

        const fileCount = packages.reduce((n, p) => n + p.files.length, 0);
        console.log(text);
        console.log(
            `Wrote ${relative(ROOT, out)} — ${packages.length} packages, ${fileCount} files.\n`
        );
        console.log('Read it, then sign it into the tag:');
        console.log(
            `  git tag -s <tag> -F ${relative(ROOT, out)} --cleanup=verbatim\n` +
                '\nThat review is the point: the signature is what tells CI these bytes were seen\n' +
                'by a human before anything was published.'
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function checkCommand() {
    const manifestPath = argValue('--manifest');
    const tarballDir = argValue('--tarballs');
    if (!manifestPath || !tarballDir) {
        console.error(
            'Usage: node scripts/release-manifest.js check --manifest <file> --tarballs <dir>'
        );
        process.exit(1);
    }

    let expected;
    try {
        expected = parse(readFileSync(resolve(ROOT, manifestPath), 'utf8'));
    } catch (err) {
        console.error(`release-manifest check: ${err.message}`);
        process.exit(1);
    }

    const problems = [];

    // Without this a manifest signed for one release could be replayed onto another commit.
    const expectCommit = argValue('--commit');
    if (expectCommit && expected.commit !== expectCommit) {
        problems.push(
            `the manifest is for commit ${expected.commit}, but this build is of ${expectCommit}`
        );
    }

    const dir = resolve(ROOT, tarballDir);
    const tarballs = readdirSync(dir)
        .filter((f) => f.endsWith('.tgz'))
        .map((f) => join(dir, f));
    const actual = hashAll(tarballs);

    const actualByName = new Map(actual.map((p) => [p.name, p]));
    const expectedNames = new Set(expected.packages.map((p) => p.name));

    for (const name of actualByName.keys()) {
        if (!expectedNames.has(name)) {
            problems.push(`${name}: built but absent from the signed manifest`);
        }
    }

    for (const want of expected.packages) {
        const got = actualByName.get(want.name);
        if (!got) {
            problems.push(`${want.name}: in the signed manifest but not built`);
            continue;
        }
        if (got.version !== want.version) {
            problems.push(`${want.name}: built ${got.version}, manifest signs ${want.version}`);
            continue;
        }

        const gotByPath = new Map(got.files.map((f) => [f.path, f.hash]));
        const wantPaths = new Set(want.files.map((f) => f.path));

        for (const f of want.files) {
            const hash = gotByPath.get(f.path);
            if (hash === undefined)
                problems.push(`${want.name}  ${f.path}: missing from the build`);
            else if (hash !== f.hash) {
                problems.push(
                    `${want.name}  ${f.path}: DIFFERS\n` +
                        `      signed: ${f.hash}\n` +
                        `      built:  ${hash}`
                );
            }
        }
        for (const f of got.files) {
            if (!wantPaths.has(f.path)) {
                problems.push(`${want.name}  ${f.path}: present in the build, not in the manifest`);
            }
        }
    }

    if (problems.length === 0) {
        const fileCount = expected.packages.reduce((n, p) => n + p.files.length, 0);
        console.log(
            `✓ every file matches the signed manifest — ${expected.packages.length} packages, ${fileCount} files.`
        );
        process.exit(0);
    }

    console.error(`✗ ${problems.length} difference(s) from the signed manifest:\n`);
    for (const msg of problems) console.error(`  ${msg}`);
    console.error(
        '\nThe build did not reproduce the bytes the maintainer signed. Either the build\n' +
            'environment differs from the one that produced the manifest (see .github/build-image),\n' +
            'or the source and the manifest are not describing the same thing. Do not publish\n' +
            'until the difference is understood.'
    );
    process.exit(1);
}

switch (command) {
    case 'generate':
        generateCommand();
        break;
    case 'check':
        checkCommand();
        break;
    default:
        console.error(`Unknown command "${command ?? ''}". See the header comment for usage.`);
        process.exit(1);
}
