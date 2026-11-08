import { splitEdition } from "./edition.ts";

/**
 * Apple Music links and album metadata.
 *
 * 1. Apple Music API (api.music.apple.com), with a developer token signed
 *    from a MusicKit key (src/musicToken.ts). Used when the key is set.
 * 2. Otherwise, or when the API refuses, the album's music.apple.com page:
 *    it carries the album as schema.org JSON-LD (the data published for
 *    search engines). One page per add.
 *
 * The free lookup API (itunes.apple.com/lookup) is not used: it answers
 * HTTP 403 with an empty body to requests from Cloudflare Workers (seen
 * 2026-11-08). Only metadata is kept.
 */

export type AppleLink =
  | { type: "album"; id: string; trackId?: string }
  | { type: "song"; id: string };

export interface AlbumInfo {
  appleId: string;
  storefront: string;
  /** Title without edition labels (see src/edition.ts). */
  title: string;
  /** Edition label taken out of Apple's title, e.g. "Remastered". */
  edition: string | null;
  artist: string;
  artistId: string | null;
  releaseDate: string | null;
  year: number | null;
  genre: string | null;
  trackCount: number | null;
  /** Total length, from the track durations Apple reports. Tracks are not stored. */
  durationMs: number | null;
  /** Artwork URL with `{w}x{h}` in place of the size. */
  artworkUrl: string | null;
  appleUrl: string;
}

/** The input is not a usable Apple Music album or song link. */
export class LinkError extends Error {
  readonly status = 400;
}

/** Apple could not be asked, or does not have the album in this storefront. */
export class LookupError extends Error {
  readonly status: number;
  /** Apple refused or could not be reached, so another source may work. */
  readonly refused: boolean;
  constructor(message: string, status: number, refused = false) {
    super(message);
    this.status = status;
    this.refused = refused;
  }
}

const HOSTS = new Set(["music.apple.com", "geo.music.apple.com", "itunes.apple.com"]);

/**
 * Reads an album or song id from an Apple Music link, e.g.
 * https://music.apple.com/ch/album/violator/665404621?l=en-GB. Text around the
 * link (some share sheets add the title) is ignored.
 */
export function parseAppleMusicLink(input: string): AppleLink {
  const match = input.match(/https?:\/\/[^\s<>"]+/);
  if (!match) throw new LinkError("No link found. Paste an Apple Music album link.");
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    throw new LinkError("That link could not be read.");
  }
  if (!HOSTS.has(url.hostname)) throw new LinkError("That is not an Apple Music link.");

  const parts = url.pathname.split("/").filter(Boolean);
  const typeAt = parts.findIndex((p) => p === "album" || p === "song");
  if (typeAt < 0 || typeAt === parts.length - 1) {
    throw new LinkError("Only album links (or song links) can be added.");
  }
  const id = parts[parts.length - 1].replace(/^id/, "");
  if (!/^\d+$/.test(id)) throw new LinkError("That link has no album id.");

  if (parts[typeAt] === "song") return { type: "song", id };
  const trackId = url.searchParams.get("i");
  return trackId && /^\d+$/.test(trackId) ? { type: "album", id, trackId } : { type: "album", id };
}

type Json = Record<string, unknown>;

const str = (o: Json, k: string): string | null => {
  const v = o[k];
  return typeof v === "string" && v.trim() !== "" ? v : null;
};
const num = (o: Json, k: string): number | null => {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const idOf = (o: Json, k: string): string | null => {
  const v = o[k];
  return typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? String(v) : null;
};

const USER_AGENT = "albums.gcameron.com/1.0 (+https://albums.gcameron.com)";

/** What the lookups need from outside, so tests can replace it. */
export interface AppleSources {
  fetch: typeof fetch;
  /** A developer token for the Apple Music API, or null when not configured. */
  musicToken(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Apple Music API

/**
 * GET api.music.apple.com/v1/catalog/<storefront>/<path>. Null when the item
 * is not in the storefront (404).
 */
async function musicApi(src: AppleSources, token: string, path: string, storefront: string): Promise<Json | null> {
  const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/${path}`);
  url.searchParams.set("l", "en-GB");
  let res: Response;
  try {
    res = await src.fetch(url.toString(), {
      headers: { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
    });
  } catch (error) {
    console.error("Apple Music API unreachable", url.toString(), String(error));
    throw new LookupError("Apple Music could not be reached. Try again.", 502, true);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error("Apple Music API refused", url.toString(), res.status, detail);
    throw new LookupError(`Apple Music API failed (HTTP ${res.status}).`, 502, true);
  }
  try {
    return (await res.json()) as Json;
  } catch {
    throw new LookupError("Apple Music sent an unreadable answer.", 502, true);
  }
}

const first = (body: Json | null): Json | undefined => asList(body?.data)[0];
const attrs = (o: Json | undefined): Json => (o && typeof o.attributes === "object" && o.attributes ? (o.attributes as Json) : {});
const related = (o: Json | undefined, name: string): Json[] => {
  const rel = o?.relationships;
  const entry = rel && typeof rel === "object" ? (rel as Json)[name] : undefined;
  return entry && typeof entry === "object" ? asList((entry as Json).data) : [];
};

function datePart(value: string | null): { releaseDate: string | null; year: number | null } {
  if (value && /^\d{4}-\d{2}-\d{2}/.test(value)) return { releaseDate: value.slice(0, 10), year: Number(value.slice(0, 4)) };
  if (value && /^\d{4}$/.test(value)) return { releaseDate: null, year: Number(value) };
  return { releaseDate: null, year: null };
}

/** Builds the album from an Apple Music API albums response. */
export function parseMusicApiAlbum(body: Json | null, storefront: string): AlbumInfo {
  const album = first(body);
  const a = attrs(album);
  const appleId = album && idOf(album, "id");
  const title = str(a, "name");
  const artist = str(a, "artistName");
  if (!appleId || !title || !artist) throw notInStore("album", storefront);

  const tracks = related(album, "tracks");

  const genres = Array.isArray(a.genreNames) ? (a.genreNames as unknown[]).filter((g): g is string => typeof g === "string") : [];
  const artwork = typeof a.artwork === "object" && a.artwork ? str(a.artwork as Json, "url") : null;
  const durations = tracks.map((t) => num(attrs(t), "durationInMillis")).filter((d): d is number => d !== null);
  const url = str(a, "url");

  return {
    appleId,
    storefront,
    ...splitEdition(title),
    artist,
    artistId: idOf(related(album, "artists")[0] ?? {}, "id"),
    ...datePart(str(a, "releaseDate")),
    genre: genres.find((g) => g !== "Music") ?? null,
    trackCount: num(a, "trackCount") ?? (tracks.length || null),
    durationMs: durations.length ? durations.reduce((x, y) => x + y, 0) : null,
    artworkUrl: artwork ? artwork.replace(/\{w\}x\{h\}[a-z]*\.(jpg|png|webp)$/, "{w}x{h}bb.jpg") : null,
    appleUrl: url ? url.split("?")[0] : `https://music.apple.com/${storefront}/album/${appleId}`,
  };
}

const notInStore = (what: string, storefront: string) =>
  new LookupError(`That ${what} is not available in the ${storefront.toUpperCase()} Apple Music store.`, 404);

// ---------------------------------------------------------------------------
// Fallback: the album page's JSON-LD

const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-GB,en;q=0.8",
  "user-agent": USER_AGENT,
};

async function fetchPage(fetchFn: typeof fetch, url: string, what: string, storefront: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: PAGE_HEADERS });
  } catch (error) {
    console.error("Apple page unreachable", url, String(error));
    throw new LookupError("Apple Music could not be reached. Try again.", 502);
  }
  if (res.status === 404) throw notInStore(what, storefront);
  if (!res.ok) {
    console.error("Apple page refused", url, res.status);
    throw new LookupError(`Apple Music refused the lookup (HTTP ${res.status}).`, 502);
  }
  return res.text();
}

const pageUrl = (type: "album" | "song", id: string, storefront: string) =>
  `https://music.apple.com/${storefront}/${type}/${id}?l=en-GB`;

/** Every JSON-LD object on the page, with arrays and @graph flattened. */
function jsonLd(html: string): Json[] {
  const found: Json[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object" && v !== null) {
      found.push(v as Json);
      const graph = (v as Json)["@graph"];
      if (graph) visit(graph);
    }
  };
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      visit(JSON.parse(m[1]));
    } catch {
      // not JSON; skip
    }
  }
  return found;
}

const isType = (o: Json, type: string) =>
  o["@type"] === type || (Array.isArray(o["@type"]) && (o["@type"] as unknown[]).includes(type));

const asList = (v: unknown): Json[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter(
    (x): x is Json => typeof x === "object" && x !== null,
  );

/** "PT4M27S" → 267000 */
export function isoDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m || value === "P" || value === "PT") return null;
  const [, d, h, min, sec] = m;
  return Math.round(((Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0)) * 1000);
}

const lastId = (url: string | null): string | null => url?.match(/\/(?:id)?(\d+)(?:[?#].*)?$/)?.[1] ?? null;

/** Builds the album from the MusicAlbum JSON-LD on its music.apple.com page. */
export function parseAlbumPage(html: string, albumId: string, storefront: string): AlbumInfo {
  const album = jsonLd(html).find((o) => isType(o, "MusicAlbum"));
  const title = album && str(album, "name");
  const artists = album ? asList(album.byArtist) : [];
  const artistNames = artists.map((a) => str(a, "name")).filter((n): n is string => n !== null);
  if (!album || !title || artistNames.length === 0) throw notInStore("album", storefront);

  const trackList = asList(album.tracks ?? album.track).flatMap((t) =>
    isType(t, "ItemList") ? asList(t.itemListElement).map((e) => asList(e.item)[0] ?? e) : [t],
  );
  const tracks = trackList.filter((t) => str(t, "name") !== null);

  const published = str(album, "datePublished");
  const releaseDate = published && /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : null;
  const genre = Array.isArray(album.genre)
    ? ((album.genre as unknown[]).find((g): g is string => typeof g === "string" && g !== "Music") ?? null)
    : str(album, "genre");
  const image = typeof album.image === "string" ? album.image : (asList(album.image).map((i) => str(i, "url"))[0] ?? null);
  const durations = tracks.map((t) => isoDurationMs(t.duration)).filter((d): d is number => d !== null);
  const url = str(album, "url");

  return {
    appleId: albumId,
    storefront,
    ...splitEdition(title),
    artist: artistNames.join(" & "),
    artistId: lastId(str(artists[0], "url")),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    genre,
    trackCount: tracks.length || null,
    durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
    artworkUrl: image ? image.replace(/\/\d+x\d+[a-z]*\.(jpg|png|webp)$/, "/{w}x{h}bb.jpg") : null,
    appleUrl: url ? url.split("?")[0] : `https://music.apple.com/${storefront}/album/${albumId}`,
  };
}

/** The album a song page belongs to: the first album link on the page. */
export function albumIdFromSongPage(html: string): string | null {
  const recording = jsonLd(html).find((o) => isType(o, "MusicRecording"));
  const inAlbum = recording ? asList(recording.inAlbum)[0] : undefined;
  const fromLd = inAlbum ? lastId(str(inAlbum, "url")) : null;
  return fromLd ?? html.match(/music\.apple\.com\/[a-z]{2}\/album\/[^"'\s/?]+\/(\d+)/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------

const refused = (error: unknown) => error instanceof LookupError && error.refused;

/** The album id a link points at; a song link is resolved to its album. */
export async function albumIdFor(link: AppleLink, storefront: string, src: AppleSources): Promise<string> {
  if (link.type === "album") return link.id;
  const token = await src.musicToken();
  if (token) {
    try {
      const song = first(await musicApi(src, token, `songs/${link.id}?include=albums`, storefront));
      if (!song) throw notInStore("song", storefront);
      const albumId = idOf(related(song, "albums")[0] ?? {}, "id");
      if (!albumId) throw notInStore("song", storefront);
      return albumId;
    } catch (error) {
      if (!refused(error)) throw error;
    }
  }
  const albumId = albumIdFromSongPage(await fetchPage(src.fetch, pageUrl("song", link.id, storefront), "song", storefront));
  if (!albumId) throw notInStore("song", storefront);
  return albumId;
}

export async function fetchAlbum(albumId: string, storefront: string, src: AppleSources): Promise<AlbumInfo> {
  const token = await src.musicToken();
  if (token) {
    try {
      return parseMusicApiAlbum(await musicApi(src, token, `albums/${albumId}`, storefront), storefront);
    } catch (error) {
      if (!refused(error)) throw error;
    }
  }
  const html = await fetchPage(src.fetch, pageUrl("album", albumId, storefront), "album", storefront);
  return parseAlbumPage(html, albumId, storefront);
}
