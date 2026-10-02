#!/usr/bin/env bash
# Loads the installed extension in a throwaway headless GNOME Shell and checks
# that copying images/text from a real Wayland client and opening the panel
# doesn't crash the shell. Fully isolated from your desktop: private runtime
# dir, private D-Bus, in-memory settings.
#
# Usage: dbus-run-session -- tests/shell-smoke.sh
#        SMOKE_ZIP=dist/<uuid>.shell-extension.zip dbus-run-session -- tests/shell-smoke.sh
# Needs: gnome-shell (46), wl-clipboard, python3-pil (to make test images).
set -uo pipefail

UUID="superv-clipboard@gouderhaithem.github.io"
WORK="$(mktemp -d)"
export XDG_RUNTIME_DIR="$WORK/run"; mkdir -m 700 "$XDG_RUNTIME_DIR"
export GSETTINGS_BACKEND=memory
# Private data dir: tests the repo's extension/ folder and keeps saved pins out of your real one.
export XDG_DATA_HOME="$WORK/data"
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
mkdir -p "$EXT_DIR/schemas"
SRC="$(cd "$(dirname "$0")/../extension" && pwd)"
if [[ -n "${SMOKE_ZIP:-}" ]]; then
    # Test the exact package that gets uploaded (./pack.sh output).
    unzip -q "$SMOKE_ZIP" -d "$EXT_DIR"
    [[ -f "$EXT_DIR/schemas/gschemas.compiled" ]] || glib-compile-schemas "$EXT_DIR/schemas"
else
    cp "$SRC"/*.js "$SRC"/metadata.json "$SRC"/stylesheet.css "$EXT_DIR/"
    cp "$SRC"/schemas/*.gschema.xml "$EXT_DIR/schemas/" && glib-compile-schemas "$EXT_DIR/schemas"
fi
unset WAYLAND_DISPLAY DISPLAY XDG_SESSION_ID

python3 - "$WORK" <<'PY'
import sys
from PIL import Image
w = sys.argv[1]
Image.new('RGB', (1200, 675), (40, 90, 160)).save(f'{w}/a.png')
Image.new('RGB', (800, 600), (200, 80, 40)).save(f'{w}/b.jpg', quality=85)
PY
printf 'hello from wl-copy' > "$WORK/t.txt"

gnome-shell --headless --wayland --unsafe-mode --virtual-monitor 1280x800 > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!
cleanup() { pkill -x wl-copy 2>/dev/null; kill "$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
sleep 9

ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
EXT="Main.extensionManager.lookup('$UUID').stateObj"
copy() { pkill -x wl-copy 2>/dev/null; WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/wayland-0" wl-copy --type "$1" < "$2"; sleep 1.5; }
fail() { echo "FAIL: $1"; grep -E "crashed|JS ERROR|CRITICAL" "$WORK/shell.log" | head; exit 1; }

ev "Main.extensionManager.enableExtension('$UUID')" >/dev/null; sleep 2
copy image/png "$WORK/a.png"
copy image/jpeg "$WORK/b.jpg"
copy text/plain "$WORK/t.txt"
kinds="$(ev "imports.system.gc(); $EXT._history.items.map(i => i.mime || 'text').join(',')")" || fail "shell unreachable"
[[ "$kinds" == *"text,image/jpeg,image/png"* ]] || fail "history was $kinds"
ev "for (let n = 0; n < 20; n++) { $EXT._popup.open(); $EXT._popup.close(); imports.system.gc(); }" >/dev/null || fail "open/close cycles"
# Paste an image from history back to the clipboard; an outside app must get the same bytes.
pkill -x wl-copy 2>/dev/null
ev "imports.system.gc(); const img = $EXT._history.items.find(i => i.mime === 'image/png'); $EXT._paster.setClipboard(img); img.bytes.get_size()" >/dev/null || fail "paste-back"
sleep 1
WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/wayland-0" timeout 5 wl-paste --type image/png | cmp -s - "$WORK/a.png" || fail "pasted image differs from the copied one"
ev "imports.system.gc(); const h = $EXT._history; h.togglePin(h.items.find(i => i.mime === 'image/jpeg').id); 'pinned'" >/dev/null || fail "pin/save image"
kill -0 "$SHELL_PID" 2>/dev/null || fail "GNOME Shell crashed"
grep -qE "crashed|ref_count" "$WORK/shell.log" && fail "crash markers in log"
sleep 1  # saves are debounced
# Turn off while a new image is still decoding, then back on: no crash, pinned image reloads.
python3 -c "from PIL import Image; Image.new('RGB', (3000, 2000), (10, 160, 90)).save('$WORK/c.png')"
pkill -x wl-copy 2>/dev/null; WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/wayland-0" wl-copy --type image/png < "$WORK/c.png"
ev "const e = Main.extensionManager.lookup('$UUID').stateObj; e.disable(); e.enable(); imports.system.gc(); 'cycled'" >/dev/null || fail "disable/enable during decode"
sleep 2
reloaded="$(ev "$EXT._history.items.map(i => (i.pinned ? 'pinned:' : '') + (i.mime || 'text')).join(',')")"
[[ "$reloaded" == *"pinned:image/jpeg"* ]] || fail "pinned image not reloaded after enable: $reloaded"
test -s "$XDG_DATA_HOME/superv-clipboard/pinned.json" || fail "pinned image was not saved"
echo "PASS: images and text from a real client, 20 panel cycles, image paste-back, pin+save, disable during decode, reload, no crash"
