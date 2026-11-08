import type { AlbumRow } from "./albums.ts";

/** Read-only queries behind the public pages and /api. Listed albums only. */

export type Sort = "added" | "artist" | "year" | "title";
export const SORTS: Record<Sort, string> = {
  added: "Recently added",
  artist: "Artist",
  year: "Year",
  title: "Title",
};

export type View = "grid" | "list";

export interface ListQuery {
  q: string;
  decade: number | null;
  genre: string;
  artist: string;
  sort: Sort;
  view: View;
  page: number;
}

export interface TrackRow {
  disc: number;
  number: number;
  title: string;
  duration_ms: number | null;
}

const PAGE_SIZE = { grid: 60, list: 200 } as const;
export const pageSize = (view: View) => PAGE_SIZE[view];

/** Reads list parameters, falling back to defaults for anything odd. */
export function parseListQuery(params: URLSearchParams): ListQuery {
  const sort = params.get("sort") ?? "";
  const decade = Number(params.get("decade"));
  const page = Number(params.get("page"));
  return {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    decade: Number.isInteger(decade) && decade >= 1900 && decade <= 2100 && decade % 10 === 0 ? decade : null,
    genre: (params.get("genre") ?? "").trim().slice(0, 100),
    artist: (params.get("artist") ?? "").trim().slice(0, 200),
    sort: sort in SORTS ? (sort as Sort) : "added",
    view: params.get("view") === "list" ? "list" : "grid",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** The same query as URL parameters, leaving out defaults. */
export function queryParams(q: ListQuery, change: Partial<ListQuery> = {}): URLSearchParams {
  const merged = { ...q, page: 1, ...change };
  const p = new URLSearchParams();
  if (merged.q) p.set("q", merged.q);
  if (merged.artist) p.set("artist", merged.artist);
  if (merged.decade) p.set("decade", String(merged.decade));
  if (merged.genre) p.set("genre", merged.genre);
  if (merged.sort !== "added") p.set("sort", merged.sort);
  if (merged.view !== "grid") p.set("view", merged.view);
  if (merged.page > 1) p.set("page", String(merged.page));
  return p;
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Artist without a leading "The ", for sorting. */
const ARTIST_KEY = "CASE WHEN artist LIKE 'The %' THEN substr(artist, 5) ELSE artist END COLLATE NOCASE";

const ORDER: Record<Sort, string> = {
  added: "added_at DESC, id DESC",
  artist: `${ARTIST_KEY}, year, title COLLATE NOCASE`,
  year: `year IS NULL, year, ${ARTIST_KEY}`,
  title: "title COLLATE NOCASE, artist COLLATE NOCASE",
};

function where(q: ListQuery): { sql: string; binds: Array<string | number> } {
  const parts = ["status = 'listed'"];
  const binds: Array<string | number> = [];
  if (q.q) {
    const term = like(q.q);
    parts.push(
      `(title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM tracks t WHERE t.album_id = albums.id AND t.title LIKE ? ESCAPE '\\'))`,
    );
    binds.push(term, term, term);
  }
  if (q.decade !== null) {
    parts.push("year BETWEEN ? AND ?");
    binds.push(q.decade, q.decade + 9);
  }
  if (q.genre) {
    parts.push("genre = ?");
    binds.push(q.genre);
  }
  if (q.artist) {
    parts.push("artist = ?");
    binds.push(q.artist);
  }
  return { sql: parts.join(" AND "), binds };
}

export async function listAlbums(db: D1Database, q: ListQuery): Promise<{ total: number; albums: AlbumRow[] }> {
  const w = where(q);
  const size = pageSize(q.view);
  const [count, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM albums WHERE ${w.sql}`).bind(...w.binds).first<{ n: number }>(),
    db
      .prepare(`SELECT * FROM albums WHERE ${w.sql} ORDER BY ${ORDER[q.sort]} LIMIT ? OFFSET ?`)
      .bind(...w.binds, size, (q.page - 1) * size)
      .all<AlbumRow>(),
  ]);
  return { total: count?.n ?? 0, albums: rows.results ?? [] };
}

export interface Facets {
  total: number;
  decades: Array<{ decade: number; n: number }>;
  genres: Array<{ genre: string; n: number }>;
}

/** What the filters can offer, across the whole list. */
export async function facets(db: D1Database): Promise<Facets> {
  const [total, decades, genres] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM albums WHERE status = 'listed'").first<{ n: number }>(),
    db
      .prepare(
        `SELECT (year / 10) * 10 AS decade, COUNT(*) AS n FROM albums
         WHERE status = 'listed' AND year IS NOT NULL GROUP BY decade ORDER BY decade`,
      )
      .all<{ decade: number; n: number }>(),
    db
      .prepare(
        `SELECT genre, COUNT(*) AS n FROM albums
         WHERE status = 'listed' AND genre IS NOT NULL GROUP BY genre ORDER BY genre COLLATE NOCASE`,
      )
      .all<{ genre: string; n: number }>(),
  ]);
  return { total: total?.n ?? 0, decades: decades.results ?? [], genres: genres.results ?? [] };
}

/** A listed album and its tracks; null if missing or removed. */
export async function getAlbum(db: D1Database, id: number): Promise<{ album: AlbumRow; tracks: TrackRow[] } | null> {
  const album = await db.prepare("SELECT * FROM albums WHERE id = ? AND status = 'listed'").bind(id).first<AlbumRow>();
  if (!album) return null;
  const tracks = await db
    .prepare("SELECT disc, number, title, duration_ms FROM tracks WHERE album_id = ? ORDER BY disc, number")
    .bind(id)
    .all<TrackRow>();
  return { album, tracks: tracks.results ?? [] };
}

/** Other listed albums by the same artist. */
export async function moreByArtist(db: D1Database, album: AlbumRow): Promise<AlbumRow[]> {
  const rows = await db
    .prepare("SELECT * FROM albums WHERE status = 'listed' AND artist = ? AND id != ? ORDER BY year, title")
    .bind(album.artist, album.id)
    .all<AlbumRow>();
  return rows.results ?? [];
}

/** Public shape of an album in API answers (no removal details). */
export function publicAlbum(a: AlbumRow) {
  return {
    id: a.id,
    apple_id: a.apple_id,
    title: a.title,
    artist: a.artist,
    year: a.year,
    release_date: a.release_date,
    genre: a.genre,
    track_count: a.track_count,
    duration_ms: a.duration_ms,
    artwork_url: a.artwork_url,
    apple_url: a.apple_url,
    note: a.note,
    added_at: a.added_at,
  };
}
