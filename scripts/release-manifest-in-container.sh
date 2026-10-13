#!/usr/bin/env bash
#
# Generates release-manifest.txt inside the same image release.yml builds in.
#
# This wrapper exists because the manifest is only useful if CI can reproduce it, and CI builds
# in a digest-pinned Linux container. package-lock.json pins the version and integrity of all 26
# @esbuild/* and 25 @rollup/rollup-* packages but not *which* one installs -- npm picks that by
# platform -- and both are on the critical path for the bundle. Running `generate` natively on
# macOS would produce a manifest that aborts the release on a difference that is nobody's fault.
#
# What it does, mirroring the build job step for step:
#
#   - refuses to run with a dirty working tree, before spending anything on a container
#   - clones HEAD into the container, so the build sees committed content only, exactly as
#     actions/checkout gives CI. Your working tree is mounted read-only and never built from.
#   - installs the pinned npm, then `npm ci --ignore-scripts`
#   - runs `release-manifest.js generate`, and copies the result out to ./release-manifest.txt
#
# Read the manifest, then sign it into the tag:
#   git tag -s <tag> -F release-manifest.txt --cleanup=verbatim
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required -- the manifest must be generated in the image CI builds in." >&2
    echo "       See .github/build-image and docs/release-setup.md." >&2
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "error: the working tree has uncommitted changes." >&2
    echo >&2
    echo "The manifest describes one specific commit -- the one you are about to tag." >&2
    echo "Commit or stash first." >&2
    exit 1
fi

image=$(tr -d '[:space:]' < .github/build-image)
# Read from package.json rather than hardcoding: release.yml's NPM_VERSION is asserted equal to
# this field by the verify job, so there is exactly one value and it lives here.
npm_version=$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")
sha=$(git rev-parse HEAD)

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

echo "Image:  $image"
echo "npm:    $npm_version"
echo "Commit: $sha"
echo

docker run --rm \
    -v "$PWD:/src:ro" \
    -v "$out:/out" \
    -e "NPM_VERSION=$npm_version" \
    -e "SHA=$sha" \
    "$image" \
    bash -euo pipefail -c '
        git config --global --add safe.directory /src
        git clone --quiet --no-hardlinks /src /build
        cd /build
        git checkout --quiet --detach "$SHA"
        # Fail here rather than at CI time: if .nvmrc, the image tag and the image itself have
        # drifted apart, the manifest you are about to sign was built on an unintended Node.
        node scripts/check-build-node.js
        npm install -g --silent "npm@${NPM_VERSION}"
        npm ci --ignore-scripts --silent
        # Written at the default path inside the clone, then copied out, so the "sign it into
        # the tag" instructions generate prints name the file as you will actually see it.
        node scripts/release-manifest.js generate
        cp release-manifest.txt /out/release-manifest.txt
    '

cp "$out/release-manifest.txt" release-manifest.txt
echo "Wrote release-manifest.txt"
