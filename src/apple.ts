/**
 * Apple Music links and album metadata. First choice is Apple's public lookup
 * API (itunes.apple.com/lookup: no key, JSON). That API refuses requests from
 * Cloudflare Workers (HTTP 403, empty body, seen 2026-11-08), so when it
 * refuses, the album's music.apple.com page is read instead: it carries the
 * album as schema.org JSON-LD (the data published for search engines). One
 * page per add; only metadata is kept.
 */

export type AppleLink =
  | { type: "album"; id: string; trackId?: string }
  | { type: "song"; id: string };

export interface Track {
  disc: number;
  number: number;
  title: string;
  durationMs: number | null;
}

export interface AlbumInfo {
  appleId: string;
  storefront: string;
  title: string;
  artist: string;
  artistId: string | null;
  releaseDate: string | null;
  year: number | null;
  genre: string | null;
  trackCount: number | null;
  durationMs: number | null;
  /** Artwork URL with `{w}x{h}` in place of the size. */
  artworkUrl: string | null;
  appleUrl: string;
  tracks: Track[];
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

/**
 * Workers send no User-Agent by default, and Apple's lookup API answers 403
 * to requests without one. Identify the site plainly.
 */
const LOOKUP_HEADERS = {
  accept: "application/json",
  "user-agent": "albums.gcameron.com/1.0 (+https://albums.gcameron.com)",
};

async function lookup(
  fetchFn: typeof fetch,
  id: string,
  storefront: string,
  withTracks: boolean,
): Promise<Json[]> {
  const url = new URL("https://itunes.apple.com/lookup");
  url.searchParams.set("id", id);
  url.searchParams.set("country", storefront);
  if (withTracks) url.searchParams.set("entity", "song");

  let res: Response;
  try {
    res = await fetchFn(url.toString(), { headers: LOOKUP_HEADERS });
  } catch (error) {
    console.error("Apple lookup unreachable", url.toString(), String(error));
    throw new LookupError("Apple Music could not be reached. Try again.", 502, true);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error("Apple lookup refused", url.toString(), res.status, detail);
    throw new LookupError(`Apple Music lookup failed (HTTP ${res.status}).`, 502, true);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LookupError("Apple Music sent an unreadable answer.", 502);
  }
  const results = (body as { results?: unknown }).results;
  return Array.isArray(results) ? results.filter((r): r is Json => typeof r === "object" && r !== null) : [];
}

const notInStore = (what: string, storefront: string) =>
  new LookupError(`That ${what} is not available in the ${storefront.toUpperCase()} Apple Music store.`, 404);

/** Turns lookup results (collection first, then its tracks) into an album. */
export function parseLookup(results: Json[], storefront: string): AlbumInfo {
  const c = results.find((r) => r.wrapperType === "collection");
  const appleId = c && idOf(c, "collectionId");
  const title = c && str(c, "collectionName");
  const artist = c && str(c, "artistName");
  if (!c || !appleId || !title || !artist) throw notInStore("album", storefront);

  const tracks: Track[] = results
    .filter((r) => r.wrapperType === "track" && idOf(r, "collectionId") === appleId)
    .map((r) => ({
      disc: num(r, "discNumber") ?? 1,
      number: num(r, "trackNumber") ?? 0,
      title: str(r, "trackName") ?? "",
      durationMs: num(r, "trackTimeMillis"),
    }))
    .filter((t) => t.number > 0 && t.title !== "")
    .sort((a, b) => a.disc - b.disc || a.number - b.number);

  const released = str(c, "releaseDate");
  const releaseDate = released && /^\d{4}-\d{2}-\d{2}/.test(released) ? released.slice(0, 10) : null;
  const durations = tracks.map((t) => t.durationMs).filter((d): d is number => d !== null);
  const artwork = str(c, "artworkUrl100");
  const viewUrl = str(c, "collectionViewUrl");

  return {
    appleId,
    storefront,
    title,
    artist,
    artistId: idOf(c, "artistId"),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    genre: str(c, "primaryGenreName"),
    trackCount: num(c, "trackCount") ?? (tracks.length || null),
    durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
    artworkUrl: artwork ? artwork.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, "/{w}x{h}bb.jpg") : null,
    appleUrl: viewUrl ? viewUrl.split("?")[0] : `https://music.apple.com/${storefront}/album/${appleId}`,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Fallback: the album page's JSON-LD

const PAGE_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-GB,en;q=0.8",
  "user-agent": LOOKUP_HEADERS["user-agent"],
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
  const tracks: Track[] = trackList
    .map((t, i) => ({ disc: 1, number: i + 1, title: str(t, "name") ?? "", durationMs: isoDurationMs(t.duration) }))
    .filter((t) => t.title !== "");

  const published = str(album, "datePublished");
  const releaseDate = published && /^\d{4}-\d{2}-\d{2}/.test(published) ? published.slice(0, 10) : null;
  const genre = Array.isArray(album.genre)
    ? ((album.genre as unknown[]).find((g): g is string => typeof g === "string" && g !== "Music") ?? null)
    : str(album, "genre");
  const image = typeof album.image === "string" ? album.image : (asList(album.image).map((i) => str(i, "url"))[0] ?? null);
  const durations = tracks.map((t) => t.durationMs).filter((d): d is number => d !== null);
  const url = str(album, "url");

  return {
    appleId: albumId,
    storefront,
    title,
    artist: artistNames.join(" & "),
    artistId: lastId(str(artists[0], "url")),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    genre,
    trackCount: tracks.length || null,
    durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
    artworkUrl: image ? image.replace(/\/\d+x\d+[a-z]*\.(jpg|png|webp)$/, "/{w}x{h}bb.jpg") : null,
    appleUrl: url ? url.split("?")[0] : `https://music.apple.com/${storefront}/album/${albumId}`,
    tracks,
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

/** The album id a link points at, looking a song up to find its album. */
export async function albumIdFor(link: AppleLink, storefront: string, fetchFn: typeof fetch): Promise<string> {
  if (link.type === "album") return link.id;
  try {
    const results = await lookup(fetchFn, link.id, storefront, false);
    const song = results.find((r) => r.wrapperType === "track");
    const albumId = song && idOf(song, "collectionId");
    if (albumId) return albumId;
  } catch (error) {
    if (!(error instanceof LookupError && error.refused)) throw error;
  }
  const albumId = albumIdFromSongPage(await fetchPage(fetchFn, pageUrl("song", link.id, storefront), "song", storefront));
  if (!albumId) throw notInStore("song", storefront);
  return albumId;
}

export async function fetchAlbum(albumId: string, storefront: string, fetchFn: typeof fetch): Promise<AlbumInfo> {
  try {
    return parseLookup(await lookup(fetchFn, albumId, storefront, true), storefront);
  } catch (error) {
    if (!(error instanceof LookupError && error.refused)) throw error;
  }
  const html = await fetchPage(fetchFn, pageUrl("album", albumId, storefront), "album", storefront);
  return parseAlbumPage(html, albumId, storefront);
}
