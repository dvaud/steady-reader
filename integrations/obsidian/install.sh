#!/bin/bash
# Installs the Steady plugin into your Obsidian vaults.
#   bash install.sh                 asks about each vault Obsidian knows
#   bash install.sh ~/path/to/vault installs into that vault only
# Then in Obsidian: Settings → Community plugins → turn on "Steady".
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

install_into() {
  local dest="$1/.obsidian/plugins/steady-reader"
  mkdir -p "$dest"
  cp "$HERE/main.js" "$HERE/manifest.json" "$dest/"
  echo "  Installed in $1"
}

if [ -n "$1" ]; then
  [ -d "$1/.obsidian" ] || { echo "$1 isn't an Obsidian vault (it has no .obsidian folder)."; exit 1; }
  install_into "$1"
  exit 0
fi

LIST="$HOME/Library/Application Support/obsidian/obsidian.json"
[ -f "$LIST" ] || { echo "Couldn't find Obsidian's list of vaults. Run: bash install.sh /path/to/your/vault"; exit 1; }
found=0
while IFS= read -r vault <&3; do
  [ -d "$vault/.obsidian" ] || continue
  found=1
  read -r -p "Install in $vault? [y/N] " yes
  case "$yes" in [yY]*) install_into "$vault" ;; esac
done 3< <(grep -o '"path":"[^"]*"' "$LIST" | sed 's/^"path":"//; s/"$//; s/\\\//\//g')
[ "$found" = 1 ] || echo "No vaults found. Run: bash install.sh /path/to/your/vault"
echo "Next, in Obsidian: Settings → Community plugins → turn on \"Steady\" (reload Obsidian if it isn't listed)."
