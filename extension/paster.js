import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {shellQuote} from './imagefile.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
// Give the previous window time to get keyboard focus back after the popup closes.
const PASTE_DELAY_MS = 60;
// Terminals paste with Ctrl+Shift+V instead of Ctrl+V.
const TERMINAL_RE = /terminal|kitty|alacritty|wezterm|konsole|tilix|ptyxis|foot|ghostty|xterm|terminator|guake|warp/i;

/** Puts an item on the clipboard and types the paste shortcut into the focused window. */
export class Paster {
    /**
     * @param {{imageFiles: import('./imagefile.js').ImageFiles, imagesAsPath: () => boolean}} options
     *   In terminals, images are saved to a file and its path is pasted instead
     *   (CLI tools like Claude Code turn a pasted image path into an attachment).
     */
    constructor({imageFiles, imagesAsPath}) {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._imageFiles = imageFiles;
        this._imagesAsPath = imagesAsPath;
        this._timeoutId = 0;
        this._pasteToken = 0;
    }

    /** Puts `item` on the clipboard and pastes it into the focused window. */
    paste(item) {
        this._cancel();
        const token = ++this._pasteToken;
        if (item.kind !== 'image' || !this._imagesAsPath() || !this._focusIsTerminal()) {
            this.setClipboard(item);
            this.pasteSoon();
            return;
        }
        this._imageFiles.save(item.bytes, item.mime).catch(e => {
            console.warn(`Super V Clipboard: cannot save image for pasting: ${e.message}`);
            return null;
        }).then(path => {
            if (token !== this._pasteToken || !this._keyboard)
                return;
            if (path)
                St.Clipboard.get_default().set_text(CLIPBOARD, shellQuote(path));
            else
                this.setClipboard(item);
            this.pasteSoon();
        });
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
        this._pasteToken++;
        this._keyboard = null;
    }

    _cancel() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _focusIsTerminal() {
        return TERMINAL_RE.test(global.display.focus_window?.get_wm_class() ?? '');
    }

    _sendPasteKeys() {
        const keys = this._focusIsTerminal()
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        let time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.PRESSED);
        for (const key of [...keys].reverse())
            this._keyboard.notify_keyval(time++, key, Clutter.KeyState.RELEASED);
    }
}
