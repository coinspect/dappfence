#!/usr/bin/env bash
#
# Generate DappFence's release manifest on a Mac that has Docker but no Node.
#
# scripts/release-manifest-in-container.sh needs bash, git, node and docker ON THE HOST. This
# supplies the first three from a throwaway container and hands that container the Mac's own
# Docker socket, so the manifest itself is still built in the digest-pinned image release.yml
# uses. Nothing about what gets hashed changes -- this only replaces the host toolchain.
#
# Why the repo is mounted at its real Mac path instead of somewhere convenient:
#
#   The inner script runs `docker run -v "$PWD:/src:ro"` and `-v "$out:/out"` against the
#   SHARED daemon, so every path it names is resolved by the Mac, not by this helper
#   container. Mounting the parent directory onto its own path makes $PWD and $TMPDIR mean
#   the same thing on both sides. Mount the repo anywhere else and the inner bind mount comes
#   up empty -- the build would then hash an empty clone instead of failing loudly.
#
# Works from inside the checkout or from alongside it. Note that if it lives INSIDE the
# checkout it has to be committed or gitignored: release-manifest-in-container.sh refuses to
# run with a dirty working tree, and an untracked file here is itself a dirty working tree.
# The preflight below says so explicitly rather than letting the inner script's generic
# "uncommitted changes" message send you hunting.
#
# Usage:
#   ./release-manifest-mac.sh [path-to-dappfence-checkout]

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

marker=scripts/release-manifest-in-container.sh

# Walk up from wherever this file sits, so it works from the repo root, from scripts/, or
# from any depth -- then fall back to a sibling checkout for the "lives next to it" layout.
find_checkout() {
    local d=$1
    while [ "$d" != / ]; do
        if [ -f "$d/$marker" ]; then
            echo "$d"
            return 0
        fi
        d=$(dirname "$d")
    done
    return 1
}

if [ -n "${1:-}" ]; then
    target=$1
elif target=$(find_checkout "$here"); then
    : # found by walking up from this script
elif [ -f "$here/dappfence/$marker" ]; then
    target=$here/dappfence
else
    echo "error: no dappfence checkout found at or above $here." >&2
    echo "       Pass one explicitly: $0 /path/to/dappfence" >&2
    exit 1
fi

if [ ! -d "$target" ]; then
    echo "error: no such directory: $target" >&2
    exit 1
fi

# -P resolves symlinks. Path parity with the Mac daemon has to be exact, and on macOS a
# convenience symlink in the path would otherwise make the two sides disagree silently.
repo=$(cd "$target" && pwd -P)
parent=$(dirname "$repo")

if [ ! -f "$repo/$marker" ]; then
    echo "error: $repo does not look like a dappfence checkout" >&2
    exit 1
fi

# The inner script refuses a dirty tree -- the manifest describes one specific commit, the one
# about to be tagged. Check it here too, so the message can name the likeliest culprit: this
# file, if it was dropped into the checkout and never committed.
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
    echo "error: $repo has uncommitted changes." >&2
    echo >&2
    git -C "$repo" status --short >&2
    echo >&2
    selfpath="$here/$(basename "${BASH_SOURCE[0]}")"
    case "$selfpath" in
        "$repo"/*)
            rel=${selfpath#"$repo"/}
            if git -C "$repo" ls-files --others --exclude-standard -- "$rel" | grep -q .; then
                echo "Note: this helper ($rel) is untracked inside the checkout, so it is" >&2
                echo "      itself the dirt. Commit it, add it to .gitignore, or move it" >&2
                echo "      outside the repo and pass the path: $0 $repo" >&2
                echo >&2
            fi
            ;;
    esac
    echo "The manifest describes one specific commit. Commit or stash first." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker not found -- install Docker Desktop." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "error: the Docker daemon is not responding. Start Docker Desktop and retry." >&2
    exit 1
fi

# Docker Desktop on macOS does not create /var/run/docker.sock unless "Allow the default
# Docker socket to be used" is ticked -- the real one lives under ~/.docker/run. Ask the CLI
# where it is instead of requiring a Docker Desktop settings change. It is mounted at the
# container's default path, so the CLI in there needs no DOCKER_HOST of its own.
sock=""
case "${DOCKER_HOST:-}" in
    unix://*) sock=${DOCKER_HOST#unix://} ;;
esac

if [ -z "$sock" ]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
    case "$endpoint" in
        unix://*) sock=${endpoint#unix://} ;;
    esac
fi

found=""
for cand in "$sock" "$HOME/.docker/run/docker.sock" /var/run/docker.sock; do
    if [ -n "$cand" ] && [ -S "$cand" ]; then
        found=$cand
        break
    fi
done

if [ -z "$found" ]; then
    echo "error: could not locate the Docker socket." >&2
    echo "       Tried \$DOCKER_HOST, 'docker context inspect', ~/.docker/run/docker.sock" >&2
    echo "       and /var/run/docker.sock." >&2
    echo >&2
    echo "       Fix either way:" >&2
    echo "         - export DOCKER_HOST=unix:///path/to/docker.sock, or" >&2
    echo "         - Docker Desktop -> Settings -> Advanced -> 'Allow the default Docker" >&2
    echo "           socket to be used'" >&2
    exit 1
fi
sock=$found

# The inner script does `out=$(mktemp -d)` and bind-mounts $out into the build container. A
# default /tmp would be this helper's own tmpfs, invisible to the Mac daemon, so the manifest
# would be copied to a path that vanishes with the container. Point TMPDIR somewhere both
# sides can see -- next to the repo, not inside it (dirty-tree check).
tmp="$parent/.release-manifest-tmp"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT

# Pinning note: this helper image only provides bash/git/node to drive the real script -- it
# never touches the bytes being hashed, which are built in the digest-pinned image named by
# .github/build-image. Pin it anyway if you want the stronger property:
#   docker pull docker:cli && docker inspect --format='{{index .RepoDigests 0}}' docker:cli
helper=${HELPER_IMAGE:-docker:cli}

echo "Repo:    $repo"
echo "Socket:  $sock"
echo "Helper:  $helper (throwaway; supplies bash/git/node only)"
echo "TMPDIR:  $tmp"
echo

docker run --rm \
    -v "$sock:/var/run/docker.sock" \
    -v "$parent:$parent" \
    -w "$repo" \
    -e "TMPDIR=$tmp" \
    -e "REPO=$repo" \
    "$helper" \
    sh -eu -c '
        apk add --no-cache bash git nodejs >/dev/null
        # The checkout is owned by the Mac user, not by root in here.
        git config --global --add safe.directory "$REPO"
        exec bash scripts/release-manifest-in-container.sh
    '

echo
echo "Read it before you sign it -- that review is the whole point of the step:"
echo "  less $repo/release-manifest.txt"
echo
echo "Then sign it into the tag:"
echo "  git -C $repo tag -s release-\$(date +%Y%m%d) -F release-manifest.txt --cleanup=verbatim"
