import GdkPixbuf from 'gi://GdkPixbuf';

// Thumbnails are decoded once, on the main thread, at this maximum size (px).
const THUMB_MAX_PX = 256;
// Refuse to decode absurdly large images (pixels), to protect GNOME Shell's memory.
const MAX_DECODE_PIXELS = 40 * 1000 * 1000;

/**
 * Decodes image bytes into a small RGBA thumbnail owned by us.
 * Returns null when the data isn't a decodable image.
 */
export function makeThumbnail(bytes) {
    const loader = new GdkPixbuf.PixbufLoader();
    let tooLarge = false;
    loader.connect('size-prepared', (_loader, width, height) => {
        tooLarge = width * height > MAX_DECODE_PIXELS;
        const scale = Math.min(1, THUMB_MAX_PX / Math.max(width, height, 1));
        loader.set_size(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    });
    try {
        loader.write_bytes(bytes);
        loader.close();
    } catch (e) {
        try {
            loader.close();
        } catch {
            // Already closed or failed; nothing else to release.
        }
        console.warn(`Super V Clipboard: ignoring undecodable image: ${e.message}`);
        return null;
    }

    let pixbuf = loader.get_pixbuf();
    if (!pixbuf || tooLarge)
        return null;
    if (!pixbuf.has_alpha)
        pixbuf = pixbuf.add_alpha(false, 0, 0, 0);
    return {
        pixels: pixbuf.read_pixel_bytes(),
        width: pixbuf.width,
        height: pixbuf.height,
        rowstride: pixbuf.rowstride,
    };
}
