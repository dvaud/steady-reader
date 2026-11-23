#!/bin/bash
# Publish a release from the committed, pushed state of main: tags v<version from pyproject.toml>
# and attaches Steady-Windows.zip, which Windows installs download and the Update button installs.
#   mac/release.sh "What changed, in a sentence or two."
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml)
uv lock --check -q || { echo "uv.lock is out of date with pyproject.toml."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first."; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Push main first."; exit 1; }
out=$(mktemp -d)/Steady-Windows.zip
git archive --format=zip --prefix=Steady/ -o "$out" HEAD -- . ':!mac' ':!Steady.command' ':!integrations/raycast'
gh release create "v$version" "$out" --title "Steady $version" --notes "${1:-}

**Windows:** download **Steady-Windows.zip**, unzip it somewhere permanent and double-click \`Steady.bat\` once; after that open Steady from the Start menu or Raycast. Already installed? Use **Update** at the top right of Steady's library page."
rm -f "$out"
