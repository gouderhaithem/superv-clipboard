import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {metaText, previewOf} from './format.js';

const MARGIN = 12;
const THUMB_SIZE = 128;
const FADE_MS = 140;

/** The Windows-style Super+V panel. */
export class ClipboardPopup {
    constructor({history, settings, onPick, onOpenSettings}) {
        this._history = history;
        this._settings = settings;
        this._onPick = onPick;
        this._onOpenSettings = onOpenSettings;
        this._reset();
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;
        this._history.prune();
        this._anchor = global.get_pointer();

        this._backdrop = new St.Widget({
            reactive: true,
            width: global.stage.width,
            height: global.stage.height,
        });
        this._backdrop.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this._panel = this._buildPanel();
        this._backdrop.add_child(this._panel);
        Main.layoutManager.uiGroup.add_child(this._backdrop);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            this.close();
            return;
        }
        this._fill(0);
        this._animateIn();
    }

    close() {
        if (!this._backdrop)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._backdrop.destroy();
        this._reset();
    }

    refresh() {
        if (this.isOpen)
            this._fill(Math.max(0, this._focusedIndex()));
    }

    destroy() {
        this.close();
    }

    _reset() {
        this._backdrop = null;
        this._panel = null;
        this._scroll = null;
        this._list = null;
        this._clearButton = null;
        this._footer = null;
        this._grab = null;
        this._anchor = [0, 0];
        this._rows = [];
        this._shown = [];
    }

    _buildPanel() {
        const panel = new St.BoxLayout({vertical: true, reactive: true, style_class: 'cbh-panel'});
        // Clicks inside the panel must not reach the backdrop (which closes it).
        panel.connect('button-press-event', () => Clutter.EVENT_STOP);

        const header = new St.BoxLayout({style_class: 'cbh-header'});
        header.add_child(new St.Label({
            text: 'Clipboard',
            style_class: 'cbh-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearButton = new St.Button({label: 'Clear all', style_class: 'cbh-clear'});
        this._clearButton.connect('clicked', () => this._history.clear());
        header.add_child(this._clearButton);
        header.add_child(this._iconButton('emblem-system-symbolic', 'Settings', false, () => {
            this.close();
            this._onOpenSettings();
        }));
        panel.add_child(header);

        this._list = new St.BoxLayout({vertical: true, style_class: 'cbh-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'cbh-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        panel.add_child(this._scroll);

        this._footer = new St.Label({style_class: 'cbh-footer'});
        panel.add_child(this._footer);
        return panel;
    }

    _fill(focusIndex) {
        this._list.destroy_all_children();
        this._shown = this._history.items;
        this._rows = this._shown.map(item => this._buildRow(item));
        this._rows.forEach(row => this._list.add_child(row));
        if (this._rows.length === 0)
            this._list.add_child(this._buildEmpty());

        const minutes = this._settings.get_int('expiry-minutes');
        this._clearButton.visible = this._shown.some(i => !i.pinned);
        this._footer.text = minutes > 0
            ? `Enter paste · Del remove · auto-delete after ${minutes} min`
            : 'Enter paste · Del remove';
        this._place();
        this._focusRow(Math.min(focusIndex, this._rows.length - 1));
    }

    _buildEmpty() {
        const box = new St.BoxLayout({vertical: true, style_class: 'cbh-empty', x_expand: true});
        box.add_child(new St.Label({text: 'Nothing here yet', style_class: 'cbh-empty-title'}));
        box.add_child(new St.Label({
            text: 'Copy something and it will show up here.',
            style_class: 'cbh-empty-text',
        }));
        return box;
    }

    _buildRow(item) {
        const minutes = this._settings.get_int('expiry-minutes');
        const body = new St.BoxLayout({vertical: true, x_expand: true});
        body.add_child(item.kind === 'image' ? this._buildThumb(item) : this._buildText(item));
        body.add_child(new St.Label({text: metaText(item, minutes), style_class: 'cbh-meta'}));

        const actions = new St.BoxLayout({
            vertical: true,
            style_class: 'cbh-actions',
            y_align: Clutter.ActorAlign.START,
        });
        actions.add_child(this._iconButton('view-pin-symbolic', item.pinned ? 'Unpin' : 'Pin',
            item.pinned, () => this._history.togglePin(item.id)));
        actions.add_child(this._iconButton('user-trash-symbolic', 'Delete',
            false, () => this._history.remove(item.id)));

        const content = new St.BoxLayout({x_expand: true});
        content.add_child(body);
        content.add_child(actions);

        const row = new St.Button({
            style_class: item.pinned ? 'cbh-item cbh-pinned' : 'cbh-item',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            accessible_name: item.kind === 'image' ? 'Image' : previewOf(item.text),
            child: content,
        });
        row.connect('clicked', () => this._pick(item));
        return row;
    }

    _buildText(item) {
        const label = new St.Label({text: previewOf(item.text), style_class: 'cbh-text', x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _buildThumb(item) {
        // Drawn from our own pre-decoded pixels on the main thread, the same way
        // GNOME Shell shows screenshot previews.
        const {pixels, width, height, rowstride} = item.thumb;
        const content = St.ImageContent.new_with_preferred_size(width, height);
        content.set_bytes(pixels, Cogl.PixelFormat.RGBA_8888, width, height, rowstride);

        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const fit = Math.min(1, (THUMB_SIZE * scaleFactor) / Math.max(width, height));
        return new St.Widget({
            content,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            width: Math.round(width * fit),
            height: Math.round(height * fit),
            style_class: 'cbh-thumb',
            x_align: Clutter.ActorAlign.START,
        });
    }

    _iconButton(iconName, label, active, onClick) {
        const button = new St.Button({
            style_class: active ? 'cbh-icon-btn cbh-active' : 'cbh-icon-btn',
            accessible_name: label,
            child: new St.Icon({icon_name: iconName, style_class: 'cbh-icon'}),
        });
        button.connect('clicked', () => onClick());
        return button;
    }

    _pick(item) {
        this.close();
        this._onPick(item);
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const superHeld = (event.get_state() &
            (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK)) !== 0;
        if (symbol === Clutter.KEY_Escape ||
            (superHeld && (symbol === Clutter.KEY_v || symbol === Clutter.KEY_V))) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const index = this._focusedIndex();
        const last = this._rows.length - 1;
        switch (symbol) {
        case Clutter.KEY_Down:
            this._focusRow(Math.min(index + 1, last));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._focusRow(Math.max(index - 1, 0));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Home:
            this._focusRow(0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_End:
            this._focusRow(last);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (index >= 0)
                this._history.remove(this._shown[index].id);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _focusedIndex() {
        const focus = global.stage.get_key_focus();
        return this._rows.findIndex(row => row === focus || row.contains(focus));
    }

    _focusRow(index) {
        const row = this._rows[index];
        if (!row) {
            this._backdrop.grab_key_focus();
            return;
        }
        row.grab_key_focus();
        if (row.has_allocation())
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    /** Opens next to the pointer, like Windows opens next to the caret, kept on screen. */
    _place() {
        const [px, py] = this._anchor;
        const monitor = Main.layoutManager.currentMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const margin = MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this._panel.get_preferred_width(-1);
        const [, height] = this._panel.get_preferred_height(width);

        const right = area.x + area.width - width - margin;
        const bottom = area.y + area.height - height - margin;
        const below = py + margin;
        const y = below <= bottom ? below : py - height - margin;
        this._panel.set_position(
            Math.round(clamp(px, area.x + margin, right)),
            Math.round(clamp(y, area.y + margin, bottom)));
    }

    _animateIn() {
        this._panel.opacity = 0;
        this._panel.translation_y = -8;
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(value, Math.max(min, max)));
}
