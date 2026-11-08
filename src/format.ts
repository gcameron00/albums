const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-08T16:00:00.000Z" → "8 Nov 2026" (UTC). */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Album length: 2819000 → "47 min"; 4320000 → "1 h 12 min". */
export function formatAlbumTime(ms: number | null): string {
  if (ms === null || ms <= 0) return "";
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Artwork template ("…/{w}x{h}bb.jpg") at a given square size. */
export function artwork(template: string | null, size: number): string | null {
  return template ? template.replace("{w}x{h}", `${size}x${size}`) : null;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
