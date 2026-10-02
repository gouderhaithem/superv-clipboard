const PREVIEW_LINES = 4;
const PREVIEW_CHARS = 220;

export function previewOf(text) {
    const lines = text.replace(/\t/g, '    ').replace(/^\s*\n/, '').split('\n');
    const joined = lines.slice(0, PREVIEW_LINES).map(l => l.trimEnd()).join('\n');
    if (joined.trim() === '')
        return '(blank)';
    const truncated = lines.length > PREVIEW_LINES || joined.length > PREVIEW_CHARS;
    return truncated ? `${joined.slice(0, PREVIEW_CHARS).trimEnd()}…` : joined;
}

export function timeAgo(ms) {
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60)
        return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

export function metaText(item, expiryMinutes) {
    const parts = [item.kind === 'image' ? 'Image' : null, timeAgo(item.time)];
    if (item.pinned) {
        parts.push('Pinned');
    } else if (expiryMinutes > 0) {
        const left = Math.max(1, Math.ceil(expiryMinutes - (Date.now() - item.time) / 60000));
        parts.push(`deletes in ${left} min`);
    }
    return parts.filter(Boolean).join(' · ');
}
