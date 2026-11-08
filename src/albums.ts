import type { AlbumInfo } from "./apple.ts";

export type Source = "web" | "shortcut" | "mcp" | "import";
export const SOURCES: readonly Source[] = ["web", "shortcut", "mcp", "import"];

export interface AlbumRow {
  id: number;
  apple_id: string;
  storefront: string;
  title: string;
  artist: string;
  artist_id: string | null;
  release_date: string | null;
  year: number | null;
  genre: string | null;
  track_count: number | null;
  duration_ms: number | null;
  artwork_url: string | null;
  apple_url: string;
  note: string | null;
  status: "listed" | "removed";
  added_at: string;
  removed_at: string | null;
  removed_reason: string | null;
  source: Source;
}

export type AddOutcome = "created" | "duplicate" | "restored";

export interface AddResult {
  outcome: AddOutcome;
  album: AlbumRow;
  summary: string;
}

export function describe(album: Pick<AlbumRow, "artist" | "title" | "year">): string {
  return `${album.artist} – ${album.title}${album.year ? ` (${album.year})` : ""}`;
}

export async function findByAppleId(db: D1Database, appleId: string): Promise<AlbumRow | null> {
  return db.prepare("SELECT * FROM albums WHERE apple_id = ?").bind(appleId).first<AlbumRow>();
}

const ALBUM_ID = "(SELECT id FROM albums WHERE apple_id = ?)";

function duplicate(album: AlbumRow): AddResult {
  return { outcome: "duplicate", album, summary: `Already on the list: ${describe(album)}` };
}

/** Puts a removed album back on the list. */
export async function restoreAlbum(
  db: D1Database,
  album: AlbumRow,
  opts: { note: string | null; source: Source; now: string },
): Promise<AddResult> {
  await db.batch([
    db
      .prepare(
        "UPDATE albums SET status = 'listed', removed_at = NULL, removed_reason = NULL, note = COALESCE(?, note) WHERE id = ?",
      )
      .bind(opts.note, album.id),
    db
      .prepare("INSERT INTO events (album_id, action, at, source, detail) VALUES (?, 'restored', ?, ?, NULL)")
      .bind(album.id, opts.now, opts.source),
  ]);
  const restored = (await findByAppleId(db, album.apple_id))!;
  return { outcome: "restored", album: restored, summary: `Restored from history: ${describe(restored)}` };
}

/**
 * Adds an album, or reports it as already listed, or restores it if it was
 * removed. The album row, its tracks and the event are written in one batch.
 */
export async function addAlbum(
  db: D1Database,
  info: AlbumInfo,
  opts: { note: string | null; source: Source; now: string },
): Promise<AddResult> {
  const existing = await findByAppleId(db, info.appleId);
  if (existing?.status === "listed") return duplicate(existing);
  if (existing) return restoreAlbum(db, existing, opts);

  const statements = [
    db
      .prepare(
        `INSERT INTO albums (apple_id, storefront, title, artist, artist_id, release_date, year, genre,
           track_count, duration_ms, artwork_url, apple_url, note, status, added_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed', ?, ?)`,
      )
      .bind(
        info.appleId,
        info.storefront,
        info.title,
        info.artist,
        info.artistId,
        info.releaseDate,
        info.year,
        info.genre,
        info.trackCount,
        info.durationMs,
        info.artworkUrl,
        info.appleUrl,
        opts.note,
        opts.now,
        opts.source,
      ),
    ...info.tracks.map((t) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO tracks (album_id, disc, number, title, duration_ms) VALUES (${ALBUM_ID}, ?, ?, ?, ?)`,
        )
        .bind(info.appleId, t.disc, t.number, t.title, t.durationMs),
    ),
    db
      .prepare(`INSERT INTO events (album_id, action, at, source, detail) VALUES (${ALBUM_ID}, 'added', ?, ?, NULL)`)
      .bind(info.appleId, opts.now, opts.source),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    // Two adds of the same album at once: the other one won.
    const winner = await findByAppleId(db, info.appleId);
    if (winner) return duplicate(winner);
    throw error;
  }
  const created = (await findByAppleId(db, info.appleId))!;
  return { outcome: "created", album: created, summary: `Added: ${describe(created)}` };
}
