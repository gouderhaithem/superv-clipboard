#!/usr/bin/env bash
# Installs Super V Clipboard for the current user.
set -euo pipefail

UUID="superv-clipboard@gouderhaithem.github.io"
SRC="$(cd "$(dirname "$0")/extension" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

command -v gnome-shell >/dev/null || { echo "GNOME Shell not found." >&2; exit 1; }
echo "GNOME Shell: $(gnome-shell --version)"

mkdir -p "$DEST/schemas"
cp "$SRC"/*.js "$SRC"/metadata.json "$SRC"/stylesheet.css "$DEST/"
cp "$SRC"/schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"
echo "Installed to $DEST"

# GNOME binds Super+V to the notification list by default; keep Super+M for it.
current="$(gsettings get org.gnome.shell.keybindings toggle-message-tray)"
if [[ "$current" == *"<Super>v"* ]]; then
    gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
    echo "Moved GNOME's notification list shortcut to Super+M (Super+V is now the clipboard)."
fi

enabled="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$enabled" != *"$UUID"* ]]; then
    if [[ "$enabled" == "@as []" || "$enabled" == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${enabled%]*}, '$UUID']"
    fi
fi

echo
echo "Done. Log out and log back in to start it (Wayland can't reload GNOME Shell live)."
echo "Then press Super+V."
