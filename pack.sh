#!/usr/bin/env bash
# Builds the zip for extensions.gnome.org into dist/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
extra=()
for f in extension/*.js; do
    case "$(basename "$f")" in extension.js|prefs.js) ;; *) extra+=(--extra-source="$(basename "$f")") ;; esac
done
gnome-extensions pack extension --force --out-dir=dist "${extra[@]}"
ls -l dist/*.shell-extension.zip
