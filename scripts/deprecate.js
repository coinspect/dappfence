#!/usr/bin/env node
/**
 * Incident-response helper for the @dappfence scope. Runs `npm deprecate` or
 * `npm dist-tag` across every publishable workspace package atomically.
 *
 * Prerequisite: maintainer must be logged in on this machine (`npm whoami`) with
 * publish rights on @dappfence. Trusted Publishing does NOT cover deprecate/dist-tag
 * operations — those need a maintainer session or a granular access token.
 *
 * DoS safety: this script only calls `npm deprecate` and `npm dist-tag`. Both are
 * reversible and neither removes tarballs. It refuses to call `npm unpublish`.
 *
 * Usage:
 *   node scripts/deprecate.js list                                     show published versions and status
 *   node scripts/deprecate.js deprecate <version> "<reason>"           single version
 *   node scripts/deprecate.js deprecate --range <from>..<to> "<reason>"  inclusive range
 *   node scripts/deprecate.js undeprecate <version>
 *   node scripts/deprecate.js undeprecate --range <from>..<to>
 *   node scripts/deprecate.js repoint-latest <safe-version>
 *   node scripts/deprecate.js sunset <version> "<reason>"              deprecate + repoint latest
 *   node scripts/deprecate.js sunset --range <from>..<to> "<reason>"   deprecate range + repoint latest to prior stable
 *
 * Every subcommand prints what it will do and requires interactive confirmation.
 * Add --yes to skip confirmation (do not use in incident mode without reading).
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rawArgs = process.argv.slice(2);
const yes = rawArgs.includes('--yes');
const dryRun = rawArgs.includes('--dry-run');
const rangeIdx = rawArgs.findIndex((a) => a === '--range');
const range = rangeIdx >= 0 ? rawArgs[rangeIdx + 1] : null;
const positional = rawArgs.filter((a, i) => {
    if (a.startsWith('--')) {
        return false;
    }
    if (rangeIdx >= 0 && i === rangeIdx + 1) {
        return false;
    }
    return true;
});
const [subcommand, ...rest] = positional;

if (!subcommand) {
    usage(0);
}

const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const publishable = (rootPkg.workspaces ?? [])
    .flatMap((pattern) => {
        const [base, glob] = pattern.split('/');
        if (glob !== '*') {
            return [`${base}/package.json`];
        }
        return readdirSync(resolve(ROOT, base), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => `${base}/${e.name}/package.json`);
    })
    .map((rel) => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')))
    .filter((p) => !p.private)
    .map((p) => p.name);

if (publishable.length === 0) {
    console.error('deprecate: no publishable packages found');
    process.exit(1);
}

if (subcommand !== 'list' && !dryRun) {
    const whoami = spawnSync('npm', ['whoami'], { encoding: 'utf8' });
    if (whoami.status !== 0) {
        console.error('deprecate: `npm whoami` failed — run `npm login` first');
        process.exit(1);
    }
    console.log(`Authenticated as: ${whoami.stdout.trim()}`);
}
if (dryRun) {
    console.log('DRY RUN — no npm commands will be executed.\n');
}

switch (subcommand) {
    case 'list': {
        listStatus();
        break;
    }
    case 'deprecate': {
        const reason = range ? rest[0] : rest[1];
        const versions = resolveVersions(range, rest[0]);
        require(reason, 'reason');
        await runAcross('deprecate', versions, reason);
        break;
    }
    case 'undeprecate': {
        const versions = resolveVersions(range, rest[0]);
        await runAcross('deprecate', versions, '');
        break;
    }
    case 'repoint-latest': {
        const [safeVersion] = rest;
        require(safeVersion, 'safe-version');
        await repointLatest(safeVersion);
        break;
    }
    case 'sunset': {
        const reason = range ? rest[0] : rest[1];
        const versions = resolveVersions(range, rest[0]);
        require(reason, 'reason');
        const safe = pickPreviousStable(versions[0]);
        console.log(`Sunset plan for ${versions.length} version(s):`);
        console.log(`  versions: ${versions.join(', ')}`);
        console.log(`  reason:   ${reason}`);
        console.log(`  repoint 'latest' → ${safe}`);
        if (!(await confirm())) {
            process.exit(1);
        }
        await runAcross('deprecate', versions, reason, { alreadyConfirmed: true });
        await repointLatest(safe, { alreadyConfirmed: true });
        break;
    }
    default:
        console.error(`unknown subcommand: ${subcommand}`);
        usage(1);
}

function resolveVersions(rangeSpec, single) {
    if (rangeSpec) {
        const m = rangeSpec.match(/^(\d+\.\d+\.\d+(?:-\S+)?)\.\.(\d+\.\d+\.\d+(?:-\S+)?)$/);
        if (!m) {
            console.error(`invalid --range value: ${rangeSpec} (expected FROM..TO)`);
            process.exit(1);
        }
        const [, from, to] = m;
        return listPublishedVersions(publishable[0])
            .filter((v) => cmpVersion(v, from) >= 0 && cmpVersion(v, to) <= 0)
            .sort(cmpVersion);
    }
    require(single, 'version');
    return [single];
}

function listPublishedVersions(name) {
    try {
        const meta = JSON.parse(execSync(`npm view ${name} --json`, { encoding: 'utf8' }));
        return Object.keys(meta.versions ?? {});
    } catch (err) {
        console.error(`could not fetch ${name} packument: ${err.message}`);
        process.exit(1);
    }
}

function listStatus() {
    for (const name of publishable) {
        console.log(`\n${name}:`);
        let meta;
        try {
            meta = JSON.parse(execSync(`npm view ${name} --json`, { encoding: 'utf8' }));
        } catch (err) {
            console.log(`  (not yet published or unreachable: ${err.message.split('\n')[0]})`);
            continue;
        }
        const versions = Object.keys(meta.versions ?? {}).sort(cmpVersion);
        const distTags = meta['dist-tags'] ?? {};
        const tagByVersion = new Map();
        for (const [tag, v] of Object.entries(distTags)) {
            tagByVersion.set(v, [...(tagByVersion.get(v) ?? []), tag]);
        }
        for (const v of versions) {
            const deprecated = meta.versions[v].deprecated;
            const tags = tagByVersion.get(v) ?? [];
            const marks = [];
            if (tags.length > 0) {
                marks.push(`[${tags.join(',')}]`);
            }
            if (deprecated) {
                marks.push(`DEPRECATED: ${deprecated}`);
            }
            console.log(`  ${v}${marks.length ? '  ' + marks.join(' ') : ''}`);
        }
    }
}

async function runAcross(command, versions, reason, { alreadyConfirmed = false } = {}) {
    const label = reason === '' ? 'un-deprecate' : 'deprecate';
    console.log(
        `\nWill ${label} ${versions.length} version(s) on ${publishable.length} package(s):`
    );
    console.log(`  versions: ${versions.join(', ')}`);
    console.log(`  packages: ${publishable.join(', ')}`);
    if (reason !== '') {
        console.log(`  reason:   ${reason}`);
    }
    if (!alreadyConfirmed && !(await confirm())) {
        process.exit(1);
    }
    for (const name of publishable) {
        for (const version of versions) {
            const spec = `${name}@${version}`;
            const args = ['deprecate', spec, reason];
            const prefix = dryRun ? '  [dry-run] ' : '$ ';
            console.log(`${prefix}npm ${args.map((a) => (a === '' ? '""' : a)).join(' ')}`);
            if (dryRun) {
                continue;
            }
            const r = spawnSync('npm', args, { stdio: 'inherit' });
            if (r.status !== 0) {
                console.error(`FAILED for ${spec} — continue manually.`);
                process.exit(2);
            }
        }
    }
    console.log(
        `\nDone. ${label} ${dryRun ? 'preview' : 'complete'} for ${versions.length} version(s).`
    );
}

async function repointLatest(safeVersion, { alreadyConfirmed = false } = {}) {
    console.log(
        `\nWill repoint 'latest' → ${safeVersion} on ${publishable.length} package(s):\n${publishable.map((n) => `  ${n}`).join('\n')}\n`
    );
    if (!alreadyConfirmed && !(await confirm())) {
        process.exit(1);
    }
    for (const name of publishable) {
        const spec = `${name}@${safeVersion}`;
        const prefix = dryRun ? '  [dry-run] ' : '$ ';
        console.log(`${prefix}npm dist-tag add ${spec} latest`);
        if (dryRun) {
            continue;
        }
        const r = spawnSync('npm', ['dist-tag', 'add', spec, 'latest'], { stdio: 'inherit' });
        if (r.status !== 0) {
            console.error(`FAILED for ${spec} — continue manually.`);
            process.exit(2);
        }
    }
    console.log(`\nDone. 'latest' ${dryRun ? 'would point' : 'now points'} at ${safeVersion}.`);
}

function pickPreviousStable(bad) {
    const versions = listPublishedVersions(publishable[0])
        .filter((v) => !v.includes('-'))
        .filter((v) => cmpVersion(v, bad) < 0)
        .sort(cmpVersion);
    if (versions.length === 0) {
        console.error(`no prior stable version found on npm before ${bad}`);
        process.exit(1);
    }
    return versions[versions.length - 1];
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

async function confirm() {
    if (yes) {
        return true;
    }
    const rl = createInterface({ input, output });
    const answer = await rl.question('Proceed? (type "yes" to confirm) ');
    rl.close();
    return answer.trim() === 'yes';
}

function require(val, name) {
    if (!val) {
        console.error(`missing required argument: ${name}`);
        usage(1);
    }
}

function usage(code) {
    console.error(
        [
            'Usage:',
            '  node scripts/deprecate.js list',
            '  node scripts/deprecate.js deprecate <version> "<reason>"',
            '  node scripts/deprecate.js deprecate --range <from>..<to> "<reason>"',
            '  node scripts/deprecate.js undeprecate <version>',
            '  node scripts/deprecate.js undeprecate --range <from>..<to>',
            '  node scripts/deprecate.js repoint-latest <safe-version>',
            '  node scripts/deprecate.js sunset <version> "<reason>"',
            '  node scripts/deprecate.js sunset --range <from>..<to> "<reason>"',
            '',
            'Flags:',
            '  --yes    skip confirmation prompt',
        ].join('\n')
    );
    process.exit(code);
}
