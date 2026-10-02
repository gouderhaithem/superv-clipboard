import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SuperVClipboardPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Super V Clipboard',
            description: 'Open with Super+V',
        });

        const expiry = new Adw.SpinRow({
            title: 'Delete items after (minutes)',
            subtitle: '0 = never. Pinned items are never deleted.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1440, step_increment: 5, page_increment: 30}),
        });
        settings.bind('expiry-minutes', expiry, 'value', Gio.SettingsBindFlags.DEFAULT);

        const maxItems = new Adw.SpinRow({
            title: 'Maximum items',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 200, step_increment: 5, page_increment: 25}),
        });
        settings.bind('max-items', maxItems, 'value', Gio.SettingsBindFlags.DEFAULT);

        const images = new Adw.SwitchRow({title: 'Keep copied images'});
        settings.bind('store-images', images, 'active', Gio.SettingsBindFlags.DEFAULT);

        const persist = new Adw.SwitchRow({
            title: 'Keep pinned items after reboot',
            subtitle: 'Saved to ~/.local/share/superv-clipboard (only you can read it)',
        });
        settings.bind('persist-pinned', persist, 'active', Gio.SettingsBindFlags.DEFAULT);

        [expiry, maxItems, images, persist].forEach(row => group.add(row));
        page.add(group);
        window.add(page);
    }
}
