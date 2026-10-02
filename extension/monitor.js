import Meta from 'gi://Meta';
import St from 'gi://St';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
// Set by password managers (KeePassXC, etc.) so clipboard tools skip secrets.
const SENSITIVE_MIMES = ['x-kde-passwordManagerHint'];

/** Watches the clipboard and reports new text/images. */
export class ClipboardMonitor {
    constructor({onText, onImage, wantImages}) {
        this._onText = onText;
        this._onImage = onImage;
        this._wantImages = wantImages;
        this._selection = null;
        this._ownerChangedId = 0;
    }

    start() {
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_sel, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && source)
                this._read();
        });
    }

    stop() {
        if (this._selection && this._ownerChangedId)
            this._selection.disconnect(this._ownerChangedId);
        this._selection = null;
        this._ownerChangedId = 0;
    }

    _read() {
        const clipboard = St.Clipboard.get_default();
        const mimes = clipboard.get_mimetypes(CLIPBOARD);
        if (mimes.some(m => SENSITIVE_MIMES.includes(m)))
            return;

        if (mimes.some(m => TEXT_MIMES.includes(m))) {
            clipboard.get_text(CLIPBOARD, (_clip, text) => {
                if (text)
                    this._onText(text);
            });
            return;
        }

        const imageMime = mimes.includes('image/png')
            ? 'image/png'
            : mimes.find(m => m.startsWith('image/'));
        if (!imageMime || !this._wantImages())
            return;
        clipboard.get_content(CLIPBOARD, imageMime, (_clip, bytes) => {
            if (bytes && bytes.get_size() > 0)
                this._onImage(bytes, imageMime);
        });
    }
}
