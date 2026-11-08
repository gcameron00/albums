import { describe, expect, it } from "vitest";
import { addAlbum } from "../src/albums.ts";
import { handle, type Deps, type Env } from "../src/app.ts";
import type { AlbumInfo } from "../src/apple.ts";
import { parseMusicApiAlbum } from "../src/apple.ts";
import { parseListQuery, queryParams } from "../src/catalog.ts";
import { formatAlbumTime, formatDate } from "../src/format.ts";
import { createTestDb } from "./helpers/d1.ts";
import { kickApi, violatorApi } from "./fixtures/apple.ts";

function info(overrides: Partial<AlbumInfo>): AlbumInfo {
  return {
    appleId: "1",
    storefront: "ch",
    title: "Untitled",
    artist: "Nobody",
    artistId: null,
    releaseDate: null,
    year: null,
    genre: null,
    trackCount: null,
    durationMs: null,
    artworkUrl: null,
    appleUrl: "https://music.apple.com/ch/album/1",
    ...overrides,
  };
}

async function setup() {
  const { d1, sqlite } = createTestDb();
  const add = (i: AlbumInfo, at: string, note: string | null = null) => addAlbum(d1, i, { note, source: "web", now: at });
  await add(parseMusicApiAlbum(violatorApi, "ch"), "2026-11-08T10:00:00.000Z", "Side two <b>is</b> perfect.\nEvery time.");
  await add(parseMusicApiAlbum(kickApi, "ch"), "2026-11-08T11:00:00.000Z");
  await add(
    info({ appleId: "1440798025", title: "Hopes and Fears", artist: "Keane", year: 2004, genre: "Alternative", releaseDate: "2004-05-10" }),
    "2026-11-08T12:00:00.000Z",
  );
  await add(info({ appleId: "9", title: "Disintegration", artist: "The Cure", year: 1989, genre: "Alternative" }), "2026-11-08T09:00:00.000Z");
  await add(info({ appleId: "10", title: "Gone", artist: "Removed Band", year: 1999 }), "2026-11-08T13:00:00.000Z");
  sqlite.exec("UPDATE albums SET status = 'removed' WHERE apple_id = '10'");

  const env: Env = {
    DB: d1,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    STOREFRONT: "ch",
    ACCESS_TEAM_DOMAIN: "x",
    ACCESS_AUD: "y",
  };
  const deps: Deps = {
    verify: async () => null,
    fetch: (async () => {
      throw new Error("no network in page tests");
    }) as typeof fetch,
    musicToken: async () => null,
    now: () => new Date("2026-11-08T16:00:00Z"),
  };
  const get = async (path: string) => handle(new Request(`https://albums.gcameron.com${path}`), env, deps);
  const text = async (path: string) => (await get(path)).text();
  const ids = Object.fromEntries(
    (sqlite.prepare("SELECT apple_id, id FROM albums").all() as Array<{ apple_id: string; id: number }>).map((r) => [r.apple_id, r.id]),
  );
  return { get, text, ids };
}

/** Album titles in page order, read from the grid or table. */
const titles = (html: string) => [...html.matchAll(/<span class="title">([^<]+)<\/span>|<td><a href="\/albums\/\d+">([^<]+)<\/a><\/td>/g)].map((m) => m[1] ?? m[2]);

describe("list page", () => {
  it("shows listed albums, newest first, without removed ones", async () => {
    const { text } = await setup();
    const html = await text("/");
    expect(titles(html)).toEqual(["Hopes and Fears", "Kick (Remastered)", "Violator", "Disintegration"]);
    expect(html).toContain("4 albums worth playing from start to finish");
    expect(html).not.toContain("Gone");
    expect(html).toContain("https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/example/source/300x300bb.jpg");
  });

  it("sorts by artist ignoring a leading The, and by year", async () => {
    const { text } = await setup();
    expect(titles(await text("/?sort=artist"))).toEqual(["Disintegration", "Violator", "Kick (Remastered)", "Hopes and Fears"]);
    expect(titles(await text("/?sort=year"))).toEqual(["Kick (Remastered)", "Disintegration", "Violator", "Hopes and Fears"]);
    expect(titles(await text("/?sort=title"))).toEqual(["Disintegration", "Hopes and Fears", "Kick (Remastered)", "Violator"]);
  });

  it("searches album titles and artists, not track names", async () => {
    const { text } = await setup();
    expect(titles(await text("/?q=viol"))).toEqual(["Violator"]);
    expect(titles(await text("/?q=enjoy+the"))).toEqual([]);
    expect(titles(await text("/?q=keane"))).toEqual(["Hopes and Fears"]);
    expect(titles(await text("/?q=100%25"))).toEqual([]);
    expect(await text("/?q=zzz")).toContain("No albums match.");
  });

  it("filters by decade, genre and artist", async () => {
    const { text } = await setup();
    expect(titles(await text("/?decade=1980"))).toEqual(["Kick (Remastered)", "Disintegration"]);
    expect(titles(await text("/?genre=Alternative&sort=year"))).toEqual(["Disintegration", "Violator", "Hopes and Fears"]);
    const artist = await text("/?artist=Depeche+Mode");
    expect(titles(artist)).toEqual(["Violator"]);
    expect(artist).toContain("<h1>Depeche Mode</h1>");
    expect(await text("/")).toContain('<option value="1980">1980s (2)</option>');
  });

  it("renders the table view", async () => {
    const { text, ids } = await setup();
    const html = await text("/?view=list&sort=artist");
    expect(html).toContain('<table class="albums">');
    expect(titles(html)).toEqual(["Disintegration", "Violator", "Kick (Remastered)", "Hopes and Fears"]);
    expect(html).toContain(`<a href="/albums/${ids["665404621"]}">Violator</a>`);
    expect(html).toContain("8 Nov 2026");
  });
});

describe("album page", () => {
  it("shows the album, note and player, without a track list", async () => {
    const { get, ids } = await setup();
    const res = await get(`/albums/${ids["665404621"]}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Violator – Depeche Mode</title>");
    expect(html).toContain("1990 · Alternative · 9 tracks · 37 min");
    expect(html).toContain("<p>Side two &lt;b&gt;is&lt;/b&gt; perfect.<br>Every time.</p>");
    expect(html).toContain('src="https://embed.music.apple.com/ch/album/665404621"');
    expect(html).toContain("On the list since 8 Nov 2026");
    expect(html).not.toContain("Enjoy the Silence");
  });

  it("is 404 for removed, missing and malformed ids", async () => {
    const { get, ids } = await setup();
    expect((await get(`/albums/${ids["10"]}`)).status).toBe(404);
    expect((await get("/albums/999")).status).toBe(404);
    expect((await get("/albums/abc")).status).toBe(404);
    expect((await get("/no-such-page")).status).toBe(404);
  });
});

describe("about and API", () => {
  it("serves the about page", async () => {
    const { get } = await setup();
    const res = await get("/about");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not just a great track or two");
  });

  it("lists albums as public JSON without removal details", async () => {
    const { get } = await setup();
    const res = await get("/api/albums?sort=artist");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { total: number; albums: Array<Record<string, unknown>> };
    expect(body.total).toBe(4);
    expect(body.albums.map((a) => a.title)).toEqual(["Disintegration", "Violator", "Kick (Remastered)", "Hopes and Fears"]);
    expect(Object.keys(body.albums[0]!)).not.toContain("removed_reason");
  });

  it("returns one album, and 404 for removed ones", async () => {
    const { get, ids } = await setup();
    const body = (await (await get(`/api/albums/${ids["665404621"]}`)).json()) as { title: string; track_count: number };
    expect(body.title).toBe("Violator");
    expect(body.track_count).toBe(9);
    expect((await get(`/api/albums/${ids["10"]}`)).status).toBe(404);
  });
});

describe("list parameters", () => {
  it("falls back to defaults for odd values", () => {
    expect(parseListQuery(new URLSearchParams("sort=rank&decade=1985&page=-2&view=x"))).toEqual({
      q: "",
      decade: null,
      genre: "",
      artist: "",
      sort: "added",
      dir: "desc",
      view: "grid",
      page: 1,
    });
  });

  it("round-trips without defaults", () => {
    const q = parseListQuery(new URLSearchParams("q=x&decade=1990&sort=year&view=list&page=3"));
    expect(queryParams(q).toString()).toBe("q=x&decade=1990&sort=year&view=list");
    expect(queryParams(q, { page: 2 }).toString()).toBe("q=x&decade=1990&sort=year&view=list&page=2");
  });
});

describe("format", () => {
  it("formats dates and lengths", () => {
    expect(formatDate("2026-11-08T16:00:00.000Z")).toBe("8 Nov 2026");
    expect(formatDate(null)).toBe("");
    expect(formatAlbumTime(2819000)).toBe("47 min");
    expect(formatAlbumTime(4320000)).toBe("1 h 12 min");
  });
});

describe("players view and random", () => {
  it("shows a lazy Apple Music player per album, 12 per page", async () => {
    const { text } = await setup();
    const html = await text("/?view=play&sort=artist");
    expect(html).toContain('<ul class="players">');
    expect(html.match(/<iframe /g)?.length).toBe(4);
    expect(html).toContain('src="https://embed.music.apple.com/ch/album/665404621"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<a href="/?sort=artist&amp;view=play" aria-current="true">Players</a>');
  });

  it("redirects to a random listed album, keeping filters", async () => {
    const { get, ids } = await setup();
    const res = await get("/random?decade=1990");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/albums/${ids["665404621"]}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const any = await get("/random");
    expect(Object.values(ids).map((id) => `/albums/${id}`)).toContain(any.headers.get("location"));
    expect(any.headers.get("location")).not.toBe(`/albums/${ids["10"]}`);
  });

  it("goes back to the filtered list when nothing matches", async () => {
    const { get } = await setup();
    const res = await get("/random?decade=1950");
    expect(res.headers.get("location")).toBe("/?decade=1950");
  });

  it("links Play something with the current filters", async () => {
    const { text } = await setup();
    expect(await text("/?genre=Alternative&sort=year&view=list")).toContain('href="/random?genre=Alternative">Play something</a>');
  });
});

describe("sortable list headings", () => {
  it("sorts by a heading and reverses on a second click", async () => {
    const { text } = await setup();
    const asc = await text("/?view=list&sort=artist");
    expect(asc).toContain('<th aria-sort="ascending"><a href="/?sort=artist&amp;dir=desc&amp;view=list">Artist');
    expect(asc).toContain('<th><a href="/?sort=year&amp;view=list">Year</a></th>');
    const desc = await text("/?view=list&sort=artist&dir=desc");
    expect(titles(desc)).toEqual(["Hopes and Fears", "Kick (Remastered)", "Violator", "Disintegration"]);
    expect(desc).toContain('<th aria-sort="descending"><a href="/?sort=artist&amp;view=list">Artist');
    expect(titles(await text("/?view=list&sort=year&dir=desc"))).toEqual(["Hopes and Fears", "Violator", "Disintegration", "Kick (Remastered)"]);
    expect(titles(await text("/?view=list&dir=asc"))).toEqual(["Disintegration", "Violator", "Kick (Remastered)", "Hopes and Fears"]);
  });

  it("keeps direction out of URLs when it is the default", () => {
    const q = parseListQuery(new URLSearchParams("sort=year&dir=desc"));
    expect(q.dir).toBe("desc");
    expect(queryParams(q).toString()).toBe("sort=year&dir=desc");
    expect(queryParams(q, { sort: "title" }).toString()).toBe("sort=title");
    expect(queryParams(parseListQuery(new URLSearchParams("sort=added&dir=desc"))).toString()).toBe("");
  });
});
