import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History} from './history.js';
import {ImageFiles} from './imagefile.js';
import {ClipboardMonitor} from './monitor.js';
import {Paster} from './paster.js';
import {ClipboardPopup} from './popup.js';

const PRUNE_INTERVAL_SECONDS = 30;
const IMAGE_CLEANUP_INTERVAL_SECONDS = 60 * 60;
// Images saved for pasting as a path are deleted after a day.
const IMAGE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export default class SuperVClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings);
        this._history.load().catch(e => logError(e, 'Super V Clipboard: loading pinned items failed'));
        this._imageFiles = new ImageFiles();
        this._paster = new Paster({
            imageFiles: this._imageFiles,
            imagesAsPath: () => this._settings.get_boolean('paste-images-as-path'),
        });

        this._popup = new ClipboardPopup({
            history: this._history,
            settings: this._settings,
            onPick: item => this._paster.paste(item),
            onOpenSettings: () => this.openPreferences(),
        });
        this._historyChangedId = this._history.connectChanged(() => this._popup.refresh());

        // Nothing is recorded while the screen is locked.
        const unlocked = () => !Main.sessionMode.isLocked;
        this._monitor = new ClipboardMonitor({
            // The path we just pasted for an image isn't something the user copied.
            onText: text => unlocked() && !this._imageFiles.isOwnPath(text) && this._history.addText(text),
            onImage: (bytes, mime) => {
                if (unlocked())
                    this._history.addImage(bytes, mime).catch(e => logError(e, 'Super V Clipboard: adding image failed'));
            },
            wantImages: () => this._settings.get_boolean('store-images'),
        });
        this._monitor.start();

        this._sessionId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._popup.close();
        });

        Main.wm.addKeybinding('toggle-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._popup.toggle());

        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PRUNE_INTERVAL_SECONDS, () => {
            this._history.prune();
            return GLib.SOURCE_CONTINUE;
        });

        this._cleanupImages();
        this._imageCleanupId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, IMAGE_CLEANUP_INTERVAL_SECONDS, () => {
            this._cleanupImages();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cleanupImages() {
        this._imageFiles.cleanup(IMAGE_FILE_MAX_AGE_MS);
    }

    disable() {
        // This extension uses the 'unlock-dialog' session mode so the in-memory
        // clipboard history survives locking the screen. While locked, the
        // shortcut is inactive (NORMAL/OVERVIEW action modes only), the panel
        // is closed, and nothing is recorded. disable() still runs on logout
        // or when the extension is turned off.
        GLib.source_remove(this._pruneId);
        GLib.source_remove(this._imageCleanupId);
        Main.wm.removeKeybinding('toggle-shortcut');
        Main.sessionMode.disconnect(this._sessionId);
        this._monitor.stop();
        this._history.disconnectChanged(this._historyChangedId);
        this._popup.destroy();
        this._paster.destroy();
        this._history.destroy();

        this._pruneId = 0;
        this._imageCleanupId = 0;
        this._imageFiles = null;
        this._sessionId = 0;
        this._historyChangedId = 0;
        this._monitor = null;
        this._popup = null;
        this._paster = null;
        this._history = null;
        this._settings = null;
    }
}
