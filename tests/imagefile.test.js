import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {ImageFiles, extensionForMime, shellQuote} from '../extension/imagefile.js';

let fails = 0;
const eq = (name, a, b) => {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (!ok)
        fails++;
    print(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`);
};

function wait(promise) {
    let done = false, value, error;
    promise.then(v => (value = v), e => (error = e)).finally(() => (done = true));
    const loop = new GLib.MainLoop(null, false);
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

const mode = path => Gio.File.new_for_path(path)
    .query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777;

// --- mime → file extension (formats Claude Code and most tools accept)
eq('png ext', extensionForMime('image/png'), 'png');
eq('jpeg ext', extensionForMime('image/jpeg'), 'jpg');
eq('gif ext', extensionForMime('image/gif'), 'gif');
eq('webp ext', extensionForMime('image/webp'), 'webp');
eq('unknown mime', extensionForMime('image/x-weird'), null);

// --- shell quoting: plain paths stay readable, others are safe to paste
eq('plain path unquoted', shellQuote('/home/a/.cache/x/ab12.png'), '/home/a/.cache/x/ab12.png');
eq('space quoted', shellQuote('/home/my user/a.png'), "'/home/my user/a.png'");
eq('single quote escaped', shellQuote("/home/o'neil/a.png"), "'/home/o'\\''neil/a.png'");

// --- saving
const tmp = GLib.dir_make_tmp('superv-img-XXXXXX');
const dir = `${tmp}/images`;
const files = new ImageFiles(dir);
const bytes = new GLib.Bytes(new TextEncoder().encode('not really a png'));

const path = wait(files.save(bytes, 'image/png'));
eq('saved inside dir with png extension', path.startsWith(`${dir}/`) && path.endsWith('.png'), true);
eq('file content intact', new TextDecoder().decode(GLib.file_get_contents(path)[1]), 'not really a png');
eq('file only readable by owner', mode(path), 0o600);
eq('dir only accessible by owner', mode(dir), 0o700);
eq('same image → same path', wait(files.save(bytes, 'image/png')), path);
eq('jpeg gets jpg extension', wait(files.save(bytes, 'image/jpeg')).endsWith('.jpg'), true);
eq('unknown mime saved as nothing', wait(files.save(bytes, 'image/x-weird')), null);
eq('remembers its own paths', [files.isOwnPath(path), files.isOwnPath(shellQuote(path)), files.isOwnPath('/etc/passwd')], [true, true, false]);

// --- cleanup removes only old files
const old = `${dir}/old.png`;
GLib.file_set_contents(old, 'x');
const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
const info = new Gio.FileInfo();
info.set_attribute_uint64('time::modified', twoDaysAgo);
Gio.File.new_for_path(old).set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
wait(files.cleanup(24 * 3600 * 1000));
wait(new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => r() ?? GLib.SOURCE_REMOVE)));
eq('old file removed', GLib.file_test(old, GLib.FileTest.EXISTS), false);
eq('fresh file kept', GLib.file_test(path, GLib.FileTest.EXISTS), true);

// --- cleanup on a missing dir is harmless
wait(new ImageFiles(`${tmp}/missing`).cleanup(1000));
eq('cleanup of missing dir ok', true, true);

print(fails ? `${fails} FAILED` : 'ALL PASSED');
if (fails)
    System.exit(1);
