#!/usr/bin/env bash
# Removes Super V Clipboard and gives Super+V back to GNOME's notification list.
set -euo pipefail

UUID="superv-clipboard@gouderhaithem.github.io"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true
enabled="$(gsettings get org.gnome.shell enabled-extensions)"
gsettings set org.gnome.shell enabled-extensions "$(echo "$enabled" | sed "s/, '$UUID'//; s/'$UUID', //; s/'$UUID'//")"
gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>v', '<Super>m']"
rm -rf "$DEST"

read -r -p "Also delete saved pinned items? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/superv-clipboard"
fi
echo "Uninstalled. Log out and back in to finish."
