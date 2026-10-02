import GLib from 'gi://GLib';
import System from 'system';
import {History} from '../extension/history.js';
import {previewOf, metaText} from '../extension/format.js';
const tmp = GLib.dir_make_tmp('superv-test-XXXXXX');
GLib.setenv('XDG_DATA_HOME', tmp, true);
let fails = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; print((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b))); };
const settings = vals => ({get_int: k => vals[k], get_boolean: k => vals[k]});
const s = settings({'max-items': 3, 'expiry-minutes': 30, 'persist-pinned': true});

const h = new History(s);
let changes = 0; h.connectChanged(() => changes++);
h.addText('a'); h.addText('b'); h.addText('a');
eq('dedupe moves to top', h.items.map(i => i.text), ['a', 'b']);
h.addText('c'); h.addText('d'); h.addText('e');
eq('trim to max-items', h.items.map(i => i.text), ['e', 'd', 'c']);
const cId = h.items[2].id; h.togglePin(cId);
h.addText('f');
eq('pinned survives trim', h.items.map(i => i.text), ['f', 'e', 'd', 'c']);
h._items = h._items.map(i => i.text === 'd' ? {...i, time: Date.now() - 31 * 60000} : i);
h._items = h._items.map(i => i.text === 'c' ? {...i, time: Date.now() - 99 * 60000} : i);
h.prune();
eq('expiry removes old unpinned only', h.items.map(i => i.text), ['f', 'e', 'c']);
h.clear();
eq('clear keeps pinned', h.items.map(i => i.text), ['c']);
const img = new GLib.Bytes(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
h.addImage(img, 'image/png'); h.addImage(img, 'image/png');
eq('image dedupe', h.items.filter(i => i.kind === 'image').length, 1);
h.togglePin(h.items[0].id);

const h2 = new History(s); h2.load();
eq('pinned persisted + reloaded', h2.items.map(i => i.kind).sort(), ['image', 'text']);
eq('reloaded image bytes intact', h2.items.find(i => i.kind === 'image').bytes.toArray().length, 7);
const info = GLib.file_test(`${tmp}/superv-clipboard/pinned.json`, GLib.FileTest.EXISTS);
eq('file exists', info, true);
h2.items.forEach(i => h2.togglePin(i.id));
eq('unpin all deletes file', GLib.file_test(`${tmp}/superv-clipboard/pinned.json`, GLib.FileTest.EXISTS), false);
eq('unpin restarts expiry clock', h2.items.every(i => Date.now() - i.time < 5000), true);
h2.addText('x'.repeat(2 * 1024 * 1024));
eq('huge text ignored', h2.items.length, 2);

eq('preview blank', previewOf('  \n  '), '(blank)');
eq('preview truncates lines', previewOf('1\n2\n3\n4\n5'), '1\n2\n3\n4…');
eq('meta unpinned', metaText({kind: 'text', time: Date.now(), pinned: false}, 30), 'Just now · deletes in 30 min');
eq('meta pinned image', metaText({kind: 'image', time: Date.now(), pinned: true}, 30), 'Image · Just now · Pinned');
print(fails ? fails + ' FAILED' : 'ALL PASSED');
if (fails)
    System.exit(1);
