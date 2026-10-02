import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

// Thumbnails are decoded once, in a worker thread, at this maximum size (px).
const THUMB_MAX_PX = 256;
// Refuse images whose header says they're absurdly large, before decoding.
const MAX_DECODE_PIXELS = 40 * 1000 * 1000;
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * Decodes image bytes (which we own) into a small RGBA thumbnail without
 * blocking GNOME Shell. Resolves to null for undecodable or oversized images
 * or when `cancellable` is cancelled.
 */
export function makeThumbnail(bytes, cancellable = null) {
    const size = imageDimensions(bytes);
    if (size && size.width * size.height > MAX_DECODE_PIXELS)
        return Promise.resolve(null);
    // Never upscale small images.
    const box = size ? Math.min(THUMB_MAX_PX, Math.max(size.width, size.height)) : THUMB_MAX_PX;

    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    return new Promise(resolve => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, box, box, true, cancellable, (_src, result) => {
            try {
                resolve(toThumb(GdkPixbuf.Pixbuf.new_from_stream_finish(result)));
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Super V Clipboard: ignoring undecodable image: ${e.message}`);
                resolve(null);
            }
        });
    });
}

function toThumb(pixbuf) {
    const rgba = pixbuf.has_alpha ? pixbuf : pixbuf.add_alpha(false, 0, 0, 0);
    return {
        pixels: rgba.read_pixel_bytes(),
        width: rgba.width,
        height: rgba.height,
        rowstride: rgba.rowstride,
    };
}

/** Reads width/height from a PNG or JPEG header; null if unknown. */
export function imageDimensions(bytes) {
    const data = bytes.toArray().subarray(0, HEADER_SCAN_BYTES);
    return pngDimensions(data) ?? jpegDimensions(data);
}

function pngDimensions(d) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (d.length < 24 || !signature.every((b, i) => d[i] === b))
        return null;
    const view = new DataView(d.buffer, d.byteOffset, d.length);
    return {width: view.getUint32(16), height: view.getUint32(20)};
}

function jpegDimensions(d) {
    if (d.length < 4 || d[0] !== 0xFF || d[1] !== 0xD8)
        return null;
    let i = 2;
    while (i + 9 < d.length) {
        if (d[i] !== 0xFF) {
            i++;
            continue;
        }
        const marker = d[i + 1];
        const length = (d[i + 2] << 8) | d[i + 3];
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker))
            return {width: (d[i + 7] << 8) | d[i + 8], height: (d[i + 5] << 8) | d[i + 6]};
        i += 2 + length;
    }
    return null;
}
