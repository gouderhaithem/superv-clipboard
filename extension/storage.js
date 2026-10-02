import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const SAVE_DELAY_MS = 300;
// Pinned items are capped well below this; anything bigger isn't ours.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Reads and writes pinned items (JSON) without blocking GNOME Shell. */
export class PinnedStore {
    constructor() {
        this._file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_data_dir(), 'superv-clipboard', 'pinned.json',
        ]));
        this._getRecords = null;
        this._timeoutId = 0;
    }

    load(cancellable) {
        return new Promise(resolve => {
            this._file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, (file, infoResult) => {
                    try {
                        const size = file.query_info_finish(infoResult).get_size();
                        if (size > MAX_FILE_BYTES)
                            throw new Error(`file is too large (${size} bytes)`);
                    } catch (e) {
                        resolve(this._failedRead(e));
                        return;
                    }
                    file.load_contents_async(cancellable, (_f, result) => {
                        try {
                            const [, contents] = file.load_contents_finish(result);
                            const records = JSON.parse(new TextDecoder().decode(contents));
                            resolve(Array.isArray(records) ? records : []);
                        } catch (e) {
                            resolve(this._failedRead(e));
                        }
                    });
                });
        });
    }

    /** Debounced: `getRecords` is called once, when the write actually happens. */
    save(getRecords) {
        this._getRecords = getRecords;
        if (this._timeoutId)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._timeoutId = 0;
            this._write(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Writes any pending save immediately (used on disable). */
    flush() {
        if (!this._timeoutId)
            return;
        GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._write(true);
    }

    _write(sync) {
        const records = this._getRecords?.() ?? [];
        this._getRecords = null;
        try {
            if (records.length === 0) {
                this._delete();
                return;
            }
            ensureDirectory(this._file.get_parent());
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(records)));
            const flags = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;
            if (sync) {
                this._file.replace_contents(bytes.toArray(), null, false, flags, null);
                return;
            }
            this._file.replace_contents_bytes_async(bytes, null, false, flags, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.error(`Super V Clipboard: cannot save pinned items: ${e.message}`);
                }
            });
        } catch (e) {
            console.error(`Super V Clipboard: cannot save pinned items: ${e.message}`);
        }
    }

    _delete() {
        try {
            this._file.delete(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
    }

    _failedRead(e) {
        const quiet = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
            e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
        if (!quiet)
            console.error(`Super V Clipboard: cannot read pinned items: ${e.message}`);
        return [];
    }
}

function ensureDirectory(dir) {
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}
