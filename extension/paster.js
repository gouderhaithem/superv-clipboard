import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
// Give the previous window time to get keyboard focus back after the popup closes.
const PASTE_DELAY_MS = 60;
// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINAL_RE = /terminal|kitty|alacritty|wezterm|konsole|tilix|ptyxis|foot|ghostty|xterm|terminator|guake|warp/i;

/** Puts an item on the clipboard and types the paste shortcut into the focused window. */
export class Paster {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._timeoutId = 0;
    }

    setClipboard(item) {
        const clipboard = St.Clipboard.get_default();
        if (item.kind === 'text')
            clipboard.set_text(CLIPBOARD, item.text);
        else
            clipboard.set_content(CLIPBOARD, item.mime, item.bytes);
    }

    pasteSoon() {
        this._cancel();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._timeoutId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._cancel();
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }

    _cancel() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _sendPasteKeys() {
        const wmClass = global.display.focus_window?.get_wm_class() ?? '';
        const keys = TERMINAL_RE.test(wmClass)
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        let time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.PRESSED);
        for (const key of [...keys].reverse())
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.RELEASED);
    }
}
