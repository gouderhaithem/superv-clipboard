import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

import {History} from '../extension/history.js';
import {previewOf, metaText} from '../extension/format.js';
import {imageDimensions} from '../extension/thumbnail.js';

const tmp = GLib.dir_make_tmp('superv-test-XXXXXX');
GLib.setenv('XDG_DATA_HOME', tmp, true);
const pinnedFile = `${tmp}/superv-clipboard/pinned.json`;


let fails = 0;
const eq = (name, a, b) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (!ok)
        fails++;
    print(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`);
};
const settings = vals => ({get_int: k => vals[k], get_boolean: k => vals[k]});
const s = settings({'max-items': 3, 'expiry-minutes': 30, 'persist-pinned': true});

/** Runs the main loop until `promise` settles (async image decoding needs it). */
function wait(promise) {
    let done = false, value, error;
    promise.then(v => (value = v), e => (error = e)).finally(() => (done = true));
    const loop = new GLib.MainLoop(null, false);
    // Poll the flag from the loop itself, so an already-settled promise can't be missed.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
        if (!done)
            return GLib.SOURCE_CONTINUE;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    if (error)
        throw error;
    return value;
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const makePng = (w, h, rgba) => {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, w, h);
    pb.fill(rgba);
    const [, buf] = pb.save_to_bufferv('png', [], []);
    return new GLib.Bytes(buf);
};
const makeJpeg = (w, h) => {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h);
    pb.fill(0x22aa44ff);
    const [, buf] = pb.save_to_bufferv('jpeg', [], []);
    return new GLib.Bytes(buf);
};
const fileExists = () => GLib.file_test(pinnedFile, GLib.FileTest.EXISTS);

// --- text history
const h = new History(s);
h.addText('a');
h.addText('b');
h.addText('a');
eq('dedupe moves to top', h.items.map(i => i.text), ['a', 'b']);
h.addText('c');
h.addText('d');
h.addText('e');
eq('trim to max-items', h.items.map(i => i.text), ['e', 'd', 'c']);
h.togglePin(h.items[2].id);
h.addText('f');
eq('pinned survives trim', h.items.map(i => i.text), ['f', 'e', 'd', 'c']);
h._items = h._items.map(i => i.text === 'd' ? {...i, time: Date.now() - 31 * 60000} : i);
h._items = h._items.map(i => i.text === 'c' ? {...i, time: Date.now() - 99 * 60000} : i);
h.prune();
eq('expiry removes old unpinned only', h.items.map(i => i.text), ['f', 'e', 'c']);
h.clear();
eq('clear keeps pinned', h.items.map(i => i.text), ['c']);

// --- images (decoded in the background)
wait(h.addImage(new GLib.Bytes(new Uint8Array([137, 80, 78, 71, 1, 2, 3])), 'image/png'));
eq('undecodable image rejected', h.items.filter(i => i.kind === 'image').length, 0);
const img = makePng(1200, 600, 0x3366ccff);
wait(h.addImage(img, 'image/png'));
wait(h.addImage(img, 'image/png'));
eq('image dedupe', h.items.filter(i => i.kind === 'image').length, 1);
const thumb = h.items.find(i => i.kind === 'image').thumb;
eq('thumbnail scaled to fit 256px, aspect kept', [thumb.width, thumb.height], [256, 128]);
eq('thumbnail pixels are RGBA', thumb.pixels.get_size() >= thumb.rowstride * (thumb.height - 1) + thumb.width * 4, true);
wait(h.addImage(makePng(40, 30, 0xff0000ff), 'image/png'));
eq('small image not upscaled', [h.items[0].thumb.width, h.items[0].thumb.height], [40, 30]);
h.remove(h.items[0].id);
wait(h.addImage(makeJpeg(300, 200), 'image/jpeg'));
eq('jpeg thumbnail', [h.items[0].mime, h.items[0].thumb.width, h.items[0].thumb.height], ['image/jpeg', 256, 171]);
h.remove(h.items[0].id);
eq('png header dimensions', imageDimensions(img), {width: 1200, height: 600});
eq('jpeg header dimensions', imageDimensions(makeJpeg(321, 123)), {width: 321, height: 123});
const huge = new Uint8Array(img.toArray());
new DataView(huge.buffer).setUint32(16, 9000);
new DataView(huge.buffer).setUint32(20, 9000);
wait(h.addImage(new GLib.Bytes(huge), 'image/png'));
eq('81 MP image refused before decoding', h.items.filter(i => i.kind === 'image').length, 1);

// --- pinned items on disk
h.togglePin(h.items.find(i => i.kind === 'image').id);
eq('save is debounced (nothing written yet)', fileExists(), false);
wait(sleep(600));
eq('debounced save written', fileExists(), true);
eq('pinned file only readable by owner', Gio.File.new_for_path(pinnedFile).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777, 0o600);

const h2 = new History(s);
wait(h2.load());
eq('pinned persisted + reloaded', h2.items.map(i => i.kind).sort(), ['image', 'text']);
eq('reloaded image bytes intact', h2.items.find(i => i.kind === 'image').bytes.get_size(), img.get_size());
eq('reloaded image has thumbnail', h2.items.find(i => i.kind === 'image').thumb.width, 256);
h2.items.forEach(i => h2.togglePin(i.id));
h2.flush();
eq('unpin all + flush deletes file', fileExists(), false);
eq('unpin restarts expiry clock', h2.items.every(i => Date.now() - i.time < 5000), true);
h2.addText('x'.repeat(2 * 1024 * 1024));
eq('huge text ignored', h2.items.length, 2);

// --- pin limits
const h3 = new History(settings({'max-items': 100, 'expiry-minutes': 30, 'persist-pinned': false}));
for (let n = 0; n < 51; n++)
    h3.addText(`item ${n}`);
const results = h3.items.map(i => h3.togglePin(i.id));
eq('pinning stops at 50 items', [results.filter(Boolean).length, h3.items.filter(i => i.pinned).length], [50, 50]);
h3.destroy();

// --- work after destroy is dropped
const h4 = new History(s);
const pending = h4.addImage(makePng(500, 500, 0x00ff00ff), 'image/png');
h4.destroy();
wait(pending);
eq('image finishing after destroy is ignored', h4.items.length, 0);

// --- formatting
eq('preview blank', previewOf('  \n  '), '(blank)');
eq('preview truncates lines', previewOf('1\n2\n3\n4\n5'), '1\n2\n3\n4…');
eq('meta unpinned', metaText({kind: 'text', time: Date.now(), pinned: false}, 30), 'Just now · deletes in 30 min');
eq('meta pinned image', metaText({kind: 'image', time: Date.now(), pinned: true}, 30), 'Image · Just now · Pinned');

print(fails ? `${fails} FAILED` : 'ALL PASSED');
if (fails)
    System.exit(1);
