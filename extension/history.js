import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * In-memory clipboard history (newest first). Unpinned items expire and are
 * trimmed to `max-items`; pinned items are optionally saved to disk.
 */
export class History {
    constructor(settings) {
        this._settings = settings;
        this._items = [];
        this._nextId = 1;
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_data_dir(), 'superv-clipboard', 'pinned.json',
        ]));
    }

    get items() {
        return this._items;
    }

    connectChanged(callback) {
        const id = this._nextListenerId++;
        this._listeners.set(id, callback);
        return id;
    }

    disconnectChanged(id) {
        this._listeners.delete(id);
    }

    addText(text) {
        if (!text || text.length > MAX_TEXT_CHARS)
            return;
        this._add({kind: 'text', text, key: `t:${text}`});
    }

    addImage(bytes, mime) {
        const size = bytes?.get_size() ?? 0;
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return;
        this._add({kind: 'image', bytes, mime, key: imageKey(bytes)});
    }

    togglePin(id) {
        const now = Date.now();
        // Unpinning restarts the expiry clock so the item doesn't vanish instantly.
        const items = this._items.map(i => i.id === id
            ? {...i, pinned: !i.pinned, time: i.pinned ? now : i.time}
            : i);
        this._items = this._trim(items);
        this._save();
        this._emit();
    }

    remove(id) {
        const target = this._items.find(i => i.id === id);
        if (!target)
            return;
        this._items = this._items.filter(i => i.id !== id);
        if (target.pinned)
            this._save();
        this._emit();
    }

    /** Like Windows: "Clear all" keeps pinned items. */
    clear() {
        this._items = this._items.filter(i => i.pinned);
        this._emit();
    }

    prune() {
        const minutes = this._settings.get_int('expiry-minutes');
        if (minutes <= 0)
            return;
        const cutoff = Date.now() - minutes * 60 * 1000;
        const kept = this._items.filter(i => i.pinned || i.time >= cutoff);
        if (kept.length !== this._items.length) {
            this._items = kept;
            this._emit();
        }
    }

    load() {
        if (!this._settings.get_boolean('persist-pinned'))
            return;
        let contents;
        try {
            [, contents] = this._file.load_contents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`Super V Clipboard: cannot read pinned items: ${e.message}`);
            return;
        }
        try {
            const records = JSON.parse(new TextDecoder().decode(contents));
            if (Array.isArray(records))
                this._items = records.map(r => this._fromRecord(r)).filter(Boolean);
        } catch (e) {
            console.error(`Super V Clipboard: pinned items file is corrupt: ${e.message}`);
        }
    }

    destroy() {
        this._listeners.clear();
        this._items = [];
    }

    _add(entry) {
        const existing = this._items.find(i => i.key === entry.key);
        const item = existing
            ? {...existing, time: Date.now()}
            : {...entry, id: this._nextId++, time: Date.now(), pinned: false};
        const rest = this._items.filter(i => i.key !== entry.key);
        this._items = this._trim([item, ...rest]);
        this._emit();
    }

    _trim(items) {
        const max = this._settings.get_int('max-items');
        let unpinned = 0;
        return items.filter(i => i.pinned || ++unpinned <= max);
    }

    _emit() {
        for (const callback of this._listeners.values()) {
            try {
                callback();
            } catch (e) {
                logError(e, 'Super V Clipboard: listener failed');
            }
        }
    }

    _fromRecord(record) {
        const time = Number.isFinite(record?.time) ? record.time : Date.now();
        const base = {id: this._nextId++, time, pinned: true};
        if (record?.kind === 'text' && typeof record.text === 'string')
            return {...base, kind: 'text', text: record.text, key: `t:${record.text}`};
        if (record?.kind === 'image' && typeof record.data === 'string') {
            const bytes = new GLib.Bytes(GLib.base64_decode(record.data));
            const mime = typeof record.mime === 'string' ? record.mime : 'image/png';
            return {...base, kind: 'image', bytes, mime, key: imageKey(bytes)};
        }
        return null;
    }

    _toRecord(item) {
        if (item.kind === 'text')
            return {kind: 'text', text: item.text, time: item.time};
        return {
            kind: 'image',
            mime: item.mime,
            data: GLib.base64_encode(item.bytes.toArray()),
            time: item.time,
        };
    }

    _save() {
        const pinned = this._items.filter(i => i.pinned);
        try {
            if (!this._settings.get_boolean('persist-pinned') || pinned.length === 0) {
                this._deleteFile();
                return;
            }
            ensureDirectory(this._file.get_parent());
            const json = JSON.stringify(pinned.map(i => this._toRecord(i)));
            this._file.replace_contents(new TextEncoder().encode(json), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`Super V Clipboard: cannot save pinned items: ${e.message}`);
        }
    }

    _deleteFile() {
        try {
            this._file.delete(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
    }
}

function imageKey(bytes) {
    return `i:${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)}`;
}

function ensureDirectory(dir) {
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}
