import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {PinnedStore} from './storage.js';
import {makeThumbnail} from './thumbnail.js';

const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PINNED_ITEMS = 50;
const MAX_PINNED_BYTES = 32 * 1024 * 1024;

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
        this._cancellable = new Gio.Cancellable();
        this._store = new PinnedStore();
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

    /** Resolves once the image is in the history (or was rejected). */
    async addImage(bytes, mime) {
        const size = bytes?.get_size() ?? 0;
        if (size === 0 || size > MAX_IMAGE_BYTES)
            return;
        const key = imageKey(bytes);
        // Already known (e.g. we just pasted it): just move it to the top, no re-decode.
        if (this._items.some(i => i.key === key)) {
            this._add({key});
            return;
        }
        const thumb = await makeThumbnail(bytes, this._cancellable);
        if (thumb && !this._cancellable.is_cancelled())
            this._add({kind: 'image', bytes, mime, thumb, key});
    }

    /** Returns false when pinning would exceed the pinned-items limits. */
    togglePin(id) {
        const target = this._items.find(i => i.id === id);
        if (!target)
            return false;
        if (!target.pinned && !this._canPin(target)) {
            console.warn('Super V Clipboard: pinned items limit reached');
            return false;
        }
        const now = Date.now();
        // Unpinning restarts the expiry clock so the item doesn't vanish instantly.
        const items = this._items.map(i => i.id === id
            ? {...i, pinned: !i.pinned, time: i.pinned ? now : i.time}
            : i);
        this._items = this._trim(items);
        this._save();
        this._emit();
        return true;
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

    /** Loads saved pinned items in the background. */
    async load() {
        if (!this._settings.get_boolean('persist-pinned'))
            return;
        const records = await this._store.load(this._cancellable);
        const loaded = await Promise.all(records.slice(0, MAX_PINNED_ITEMS).map(r => this._fromRecord(r)));
        if (this._cancellable.is_cancelled())
            return;
        const known = new Set(this._items.map(i => i.key));
        const fresh = loaded.filter(i => i && !known.has(i.key));
        if (fresh.length > 0) {
            this._items = [...this._items, ...fresh];
            this._emit();
        }
    }

    /** Writes any pending save right away. */
    flush() {
        this._store.flush();
    }

    destroy() {
        this._cancellable.cancel();
        this._store.flush();
        this._listeners.clear();
        this._items = [];
    }

    _canPin(item) {
        const pinned = this._items.filter(i => i.pinned);
        const bytes = [...pinned, item].reduce((sum, i) => sum + (i.bytes?.get_size() ?? i.text.length), 0);
        return pinned.length < MAX_PINNED_ITEMS && bytes <= MAX_PINNED_BYTES;
    }

    _add(entry) {
        const existing = this._items.find(i => i.key === entry.key);
        if (!existing && !entry.kind)
            return;
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

    async _fromRecord(record) {
        const time = Number.isFinite(record?.time) ? record.time : Date.now();
        const base = {time, pinned: true};
        if (record?.kind === 'text' && typeof record.text === 'string' && record.text.length <= MAX_TEXT_CHARS)
            return {...base, id: this._nextId++, kind: 'text', text: record.text, key: `t:${record.text}`};
        if (record?.kind !== 'image' || typeof record.data !== 'string')
            return null;

        const bytes = new GLib.Bytes(GLib.base64_decode(record.data));
        if (bytes.get_size() === 0 || bytes.get_size() > MAX_IMAGE_BYTES)
            return null;
        const thumb = await makeThumbnail(bytes, this._cancellable);
        if (!thumb)
            return null;
        const mime = typeof record.mime === 'string' ? record.mime : 'image/png';
        return {...base, id: this._nextId++, kind: 'image', bytes, mime, thumb, key: imageKey(bytes)};
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
        const persist = this._settings.get_boolean('persist-pinned');
        // Records are built only when the debounced write runs.
        this._store.save(() => persist
            ? this._items.filter(i => i.pinned).map(i => this._toRecord(i))
            : []);
    }
}

function imageKey(bytes) {
    return `i:${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes)}`;
}
