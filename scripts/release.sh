#!/bin/sh
# Publish aim v<version> as a GitHub release: aim-<version>.tgz (the app with its production
# dependencies, so installing needs neither npm nor access to this repo) and SHA256SUMS.
# Run on main after the version bump has merged: scripts/release.sh 0.5.1
set -eu
v="${1:?usage: scripts/release.sh <version>}"
tag="v$v"
grep -q "\"version\": \"$v\"" package.json || { echo "package.json is not at $v" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { git tag "$tag" && git push -q origin "$tag"; }
work=$(mktemp -d)
mkdir "$work/app"
git archive "$tag" | tar -x -C "$work/app"
(cd "$work/app" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null && rm -rf .github scripts test)
mkdir -p dist
tar -czf "dist/aim-$v.tgz" -C "$work/app" .
(cd dist && shasum -a 256 "aim-$v.tgz" > SHA256SUMS && cat SHA256SUMS)
gh release create "$tag" "dist/aim-$v.tgz" dist/SHA256SUMS --title "aim $v" --notes "Install without npm or repo access (checksum-verified): \`aim install-command\` prints the one-liner, or see README.md."
rm -rf "$work"
