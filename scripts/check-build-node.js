#!/usr/bin/env node
/**
 * Asserts that the Node running this script is the one both .nvmrc and .github/build-image claim.
 *
 * Run this *inside the build container* -- it is the only place all three values can be compared,
 * and it will fail anywhere else by design. Two call sites: the build job in release.yml, and
 * scripts/release-manifest-in-container.sh, so a maintainer finds a drift before tagging rather
 * than from a failed release run.
 *
 * Why it is needed at all:
 *
 *   - **The image tag is not checked by anything else.** `node:24.21.0-bookworm@sha256:...` carries
 *     both a tag and a digest, and when both are present the digest decides what is pulled -- the
 *     tag is ignored. So the human-readable version can say anything at all and still resolve to
 *     the same image, exactly like a stale version comment beside a pinned action SHA. verify
 *     compares that string to release.yml's `container.image` literal, which catches the two
 *     drifting from each other but not either one drifting from the image it names. `process.version`
 *     is the only value that comes from the image itself.
 *
 *   - **.nvmrc drives every job except build.** verify, test and publish install Node with
 *     setup-node from .nvmrc; build takes it from the image. Bump one without re-pinning the other
 *     and the tests run on a different Node than the bytes being released. The hash gate does not
 *     catch this: the maintainer's manifest is generated in the same container the build runs in,
 *     so the two stay consistent with each other while both diverge from the rest of the repo.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const running = process.version.replace(/^v/, '');
const nvmrc = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();

const imageRef = readFileSync(resolve(ROOT, '.github/build-image'), 'utf8').trim();
// node:<version>-<variant>@sha256:<digest> -- the version is the tag's leading numeric component.
const tagged = /^node:(\d+\.\d+\.\d+)-/.exec(imageRef)?.[1];

const problems = [];

if (!tagged) {
    problems.push(
        `.github/build-image does not name a Node version: "${imageRef}"\n` +
            '    Expected the form node:<major>.<minor>.<patch>-<variant>@sha256:<digest>.'
    );
} else if (tagged !== running) {
    problems.push(
        `.github/build-image is tagged ${tagged}, but the image actually runs Node ${running}.\n` +
            '    The digest is what gets pulled; the tag beside it is decoration and has gone stale.\n' +
            '    Correct the tag to match the digest, or re-pin the digest to the version you meant.'
    );
}

if (nvmrc !== running) {
    problems.push(
        `.nvmrc says ${nvmrc}, but the build image runs Node ${running}.\n` +
            '    Every job except build installs Node from .nvmrc, so these drifting apart means the\n' +
            '    tests run on a different Node than the released bytes are built with.'
    );
}

if (problems.length > 0) {
    console.error('✗ the build image and the repository disagree about the Node version:\n');
    for (const p of problems) console.error(`  ${p}\n`);
    console.error(
        'All three must agree: .nvmrc, the tag in .github/build-image, and the image the digest\n' +
            'resolves to. See docs/release-setup.md, "Upgrading the build image".'
    );
    process.exit(1);
}

console.log(`✓ Node ${running} — matches .nvmrc and the .github/build-image tag.`);
