import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Formats that CLI tools taking image paths (e.g. Claude Code) understand.
const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};
const SAFE_PATH_RE = /^[\w@%+=:,./-]+$/;
const ENUM_BATCH = 64;

/** @returns {string|null} file extension for an image mime type, or null if unsupported. */
export function extensionForMime(mime) {
    return EXTENSIONS[mime] ?? null;
}

/** @returns {string} `path`, single-quoted only when a shell would need it. */
export function shellQuote(path) {
    return SAFE_PATH_RE.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Default folder for images saved so they can be pasted as a path. */
export function defaultImageDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'superv-clipboard', 'images']);
}

/**
 * Writes clipboard images to private files (named by content hash) so a
 * terminal can be given a path instead of image data. Never blocks the shell.
 */
export class ImageFiles {
    constructor(dir = defaultImageDir()) {
        this._dir = dir;
        this._paths = new Set();
    }

    /** @returns {Promise<string|null>} the saved file's path, or null if the format is unsupported. */
    save(bytes, mime) {
        const ext = extensionForMime(mime);
        if (!ext)
            return Promise.resolve(null);
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes).slice(0, 32);
        const path = GLib.build_filenamev([this._dir, `${hash}.${ext}`]);
        if (GLib.mkdir_with_parents(this._dir, 0o700) !== 0)
            return Promise.reject(new Error(`cannot create ${this._dir}`));

        const flags = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;
        return new Promise((resolve, reject) => {
            Gio.File.new_for_path(path).replace_contents_bytes_async(bytes, null, false, flags, null,
                (file, result) => {
                    try {
                        file.replace_contents_finish(result);
                        this._paths.add(path);
                        resolve(path);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /** True if `text` is (the quoted form of) a path this instance saved. */
    isOwnPath(text) {
        const trimmed = text.trim();
        return [...this._paths].some(p => trimmed === p || trimmed === shellQuote(p));
    }

    /** Deletes saved images older than `maxAgeMs`. Resolves when done; never rejects. */
    cleanup(maxAgeMs) {
        const cutoff = Date.now() / 1000 - maxAgeMs / 1000;
        const dir = Gio.File.new_for_path(this._dir);
        return new Promise(resolve => {
            dir.enumerate_children_async('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null, (_d, res) => {
                    let enumerator;
                    try {
                        enumerator = dir.enumerate_children_finish(res);
                    } catch (e) {
                        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                            console.warn(`Super V Clipboard: cannot clean ${this._dir}: ${e.message}`);
                        resolve();
                        return;
                    }
                    this._deleteOld(enumerator, dir, cutoff, resolve);
                });
        });
    }

    _deleteOld(enumerator, dir, cutoff, done) {
        enumerator.next_files_async(ENUM_BATCH, GLib.PRIORITY_LOW, null, (_e, res) => {
            let infos;
            try {
                infos = enumerator.next_files_finish(res);
            } catch (e) {
                console.warn(`Super V Clipboard: cannot clean ${this._dir}: ${e.message}`);
                infos = [];
            }
            if (infos.length === 0) {
                enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                done();
                return;
            }
            infos.filter(info => info.get_attribute_uint64('time::modified') < cutoff)
                .forEach(info => this._delete(dir.get_child(info.get_name())));
            this._deleteOld(enumerator, dir, cutoff, done);
        });
    }

    _delete(file) {
        this._paths.delete(file.get_path());
        file.delete_async(GLib.PRIORITY_LOW, null, (_f, res) => {
            try {
                file.delete_finish(res);
            } catch (e) {
                console.warn(`Super V Clipboard: cannot delete ${file.get_path()}: ${e.message}`);
            }
        });
    }
}
