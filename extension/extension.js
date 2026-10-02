import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History} from './history.js';
import {ClipboardMonitor} from './monitor.js';
import {Paster} from './paster.js';
import {ClipboardPopup} from './popup.js';

const PRUNE_INTERVAL_SECONDS = 30;

export default class SuperVClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings);
        this._history.load().catch(e => logError(e, 'Super V Clipboard: loading pinned items failed'));
        this._paster = new Paster();

        this._popup = new ClipboardPopup({
            history: this._history,
            settings: this._settings,
            onPick: item => {
                this._paster.setClipboard(item);
                this._paster.pasteSoon();
            },
            onOpenSettings: () => this.openPreferences(),
        });
        this._historyChangedId = this._history.connectChanged(() => this._popup.refresh());

        // Nothing is recorded while the screen is locked.
        const unlocked = () => !Main.sessionMode.isLocked;
        this._monitor = new ClipboardMonitor({
            onText: text => unlocked() && this._history.addText(text),
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
    }

    // This extension also runs in the 'unlock-dialog' session mode so the
    // in-memory history survives locking the screen. While locked, the shortcut
    // is inactive (NORMAL/OVERVIEW action modes only), the panel is closed, and
    // nothing is recorded. disable() still runs on logout or when turned off.
    disable() {
        GLib.source_remove(this._pruneId);
        Main.wm.removeKeybinding('toggle-shortcut');
        Main.sessionMode.disconnect(this._sessionId);
        this._monitor.stop();
        this._history.disconnectChanged(this._historyChangedId);
        this._popup.destroy();
        this._paster.destroy();
        this._history.destroy();

        this._pruneId = 0;
        this._sessionId = 0;
        this._historyChangedId = 0;
        this._monitor = null;
        this._popup = null;
        this._paster = null;
        this._history = null;
        this._settings = null;
    }
}
