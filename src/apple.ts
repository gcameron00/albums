/**
 * Apple Music links and album metadata from Apple's public lookup API
 * (itunes.apple.com/lookup: no key, JSON). Only metadata is used; nothing is
 * scraped from music.apple.com.
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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    res = await fetchFn(url.toString(), { headers: { accept: "application/json" } });
  } catch {
    throw new LookupError("Apple Music could not be reached. Try again.", 502);
  }
  if (!res.ok) throw new LookupError(`Apple Music lookup failed (HTTP ${res.status}).`, 502);
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

/** The album id a link points at, looking a song up to find its album. */
export async function albumIdFor(link: AppleLink, storefront: string, fetchFn: typeof fetch): Promise<string> {
  if (link.type === "album") return link.id;
  const results = await lookup(fetchFn, link.id, storefront, false);
  const song = results.find((r) => r.wrapperType === "track");
  const albumId = song && idOf(song, "collectionId");
  if (!albumId) throw notInStore("song", storefront);
  return albumId;
}

export async function fetchAlbum(albumId: string, storefront: string, fetchFn: typeof fetch): Promise<AlbumInfo> {
  return parseLookup(await lookup(fetchFn, albumId, storefront, true), storefront);
}
