import { describe, expect, it } from "vitest";
import { handle, type Deps, type Env } from "../src/app.ts";
import type { Identity } from "../src/auth.ts";
import { escapeHtml } from "../src/html.ts";
import { createTestDb } from "./helpers/d1.ts";
import { kickApi, personalJesusApi, personalJesusPage, violatorApi, violatorPage } from "./fixtures/apple.ts";

const ME: Identity = { email: "me@gcameron.com", serviceToken: null };

const API: Record<string, unknown> = {
  "/v1/catalog/ch/albums/665404621": violatorApi,
  "/v1/catalog/ch/albums/1440855131": kickApi,
  "/v1/catalog/ch/songs/665404702": personalJesusApi,
};

const PAGES: Record<string, string> = {
  "/ch/album/665404621": violatorPage,
  "/ch/song/665404702": personalJesusPage,
};

interface Options {
  who?: Identity | null;
  /** Developer token; null means the MusicKit key is not configured. */
  token?: string | null;
  /** Force every Apple Music API answer to this status. */
  apiStatus?: number;
}

function setup(opts: Options = {}) {
  const { d1, sqlite } = createTestDb();
  const env: Env = {
    DB: d1,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    STOREFRONT: "ch",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  };
  const apiCalls: string[] = [];
  const pages: string[] = [];
  const headers: Headers[] = [];
  const deps: Deps = {
    verify: async () => (opts.who === undefined ? ME : opts.who),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      headers.push(new Headers(init?.headers));
      if (url.hostname === "api.music.apple.com") {
        apiCalls.push(url.pathname + url.search);
        if (opts.apiStatus) return new Response("", { status: opts.apiStatus });
        const body = API[url.pathname];
        return body ? Response.json(body) : Response.json({ errors: [{ status: "404" }] }, { status: 404 });
      }
      if (url.hostname === "music.apple.com") {
        pages.push(url.pathname + url.search);
        const page = PAGES[url.pathname];
        return page ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("", { status: 404 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    musicToken: async () => (opts.token === undefined ? "test-token" : opts.token),
    now: () => new Date("2026-11-08T16:00:00Z"),
  };
  const run = (req: Request) => handle(req, env, deps);
  return { run, sqlite, apiCalls, pages, headers };
}

const get = (path: string) => new Request(`https://albums.gcameron.com${path}`);
const add = (body: unknown, extra: Record<string, string> = {}) =>
  new Request("https://albums.gcameron.com/admin/albums", {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });

const VIOLATOR = "https://music.apple.com/ch/album/violator/665404621?l=en-GB";

describe("public routes", () => {
  it("answers /health", async () => {
    const res = await setup().run(get("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("renders the home page with the album count", async () => {
    const { run } = setup();
    expect(await (await run(get("/"))).text()).toContain("0 albums so far");
    await run(add({ url: VIOLATOR }));
    expect(await (await run(get("/"))).text()).toContain("1 album so far");
  });

  it("passes other paths to static assets", async () => {
    const res = await setup().run(get("/assets/missing.css"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("asset");
  });
});

describe("admin access", () => {
  it("refuses requests without a valid Access token", async () => {
    const { run } = setup({ who: null });
    expect((await run(get("/admin"))).status).toBe(401);
    expect((await run(add({ url: "https://music.apple.com/ch/album/violator/665404621" }))).status).toBe(401);
  });

  it("shows who is signed in", async () => {
    const res = await setup().run(get("/admin"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Signed in as me@gcameron.com");
  });

  it("refuses cross-site posts and non-JSON bodies", async () => {
    const { run } = setup();
    const url = "https://music.apple.com/ch/album/violator/665404621";
    expect((await run(add({ url }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    const form = new Request("https://albums.gcameron.com/admin/albums", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `url=${encodeURIComponent(url)}`,
    });
    expect((await run(form)).status).toBe(415);
  });
});

describe("POST /admin/albums", () => {
  it("adds an album from the Apple Music API, with its tracks and an event", async () => {
    const { run, sqlite, apiCalls, pages, headers } = setup();
    const res = await run(add({ url: VIOLATOR, note: "  Side two!  ", source: "shortcut" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: string; summary: string; album: Record<string, unknown> };
    expect(body.outcome).toBe("created");
    expect(body.summary).toBe("Added: Depeche Mode – Violator (1990)");
    expect(body.album).toMatchObject({ title: "Violator", year: 1990, note: "Side two!" });
    expect(apiCalls).toEqual(["/v1/catalog/ch/albums/665404621?l=en-GB"]);
    expect(pages).toEqual([]);
    expect(headers[0]?.get("authorization")).toBe("Bearer test-token");
    expect(headers[0]?.get("user-agent")).toBe("albums.gcameron.com/1.0 (+https://albums.gcameron.com)");

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tracks").get()).toEqual({ n: 9 });
    expect(sqlite.prepare("SELECT action, source, at FROM events").all()).toEqual([
      { action: "added", source: "shortcut", at: "2026-11-08T16:00:00.000Z" },
    ]);
  });

  it("reports a duplicate without asking Apple again", async () => {
    const { run, apiCalls } = setup();
    await run(add({ url: VIOLATOR }));
    const res = await run(add({ url: VIOLATOR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "duplicate", summary: "Already on the list: Depeche Mode – Violator (1990)" });
    expect(apiCalls).toHaveLength(1);
  });

  it("restores a removed album", async () => {
    const { run, sqlite } = setup();
    await run(add({ url: VIOLATOR }));
    sqlite.exec("UPDATE albums SET status = 'removed', removed_at = 'x', removed_reason = 'tired of it'");
    const res = await run(add({ url: VIOLATOR }));
    expect(await res.json()).toMatchObject({ outcome: "restored", summary: "Restored from history: Depeche Mode – Violator (1990)" });
    expect(sqlite.prepare("SELECT status, removed_reason FROM albums").get()).toEqual({ status: "listed", removed_reason: null });
    expect(sqlite.prepare("SELECT action FROM events ORDER BY id").all()).toEqual([{ action: "added" }, { action: "restored" }]);
  });

  it("finds the album from a song link", async () => {
    const { run, apiCalls } = setup();
    const res = await run(add({ url: "https://music.apple.com/ch/song/personal-jesus/665404702" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ album: { apple_id: "665404621" } });
    expect(apiCalls).toEqual([
      "/v1/catalog/ch/songs/665404702?include=albums&l=en-GB",
      "/v1/catalog/ch/albums/665404621?l=en-GB",
    ]);
  });

  it("explains bad links and albums missing from the Swiss store", async () => {
    const { run, pages } = setup();
    expect((await run(add({ url: "https://music.apple.com/ch/playlist/x/pl.123" }))).status).toBe(400);
    const missing = await run(add({ url: "https://music.apple.com/ch/album/hopes-and-fears/1440798025" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ summary: "That album is not available in the CH Apple Music store." });
    expect(pages).toEqual([]);
  });

  it("reads the album page when the MusicKit key is not configured", async () => {
    const { run, apiCalls, pages, sqlite } = setup({ token: null });
    const res = await run(add({ url: VIOLATOR }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ summary: "Added: Depeche Mode – Violator (1990)" });
    expect(apiCalls).toEqual([]);
    expect(pages).toEqual(["/ch/album/665404621?l=en-GB"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tracks").get()).toEqual({ n: 9 });
  });

  it("reads the album page when the Apple Music API refuses", async () => {
    const { run, pages } = setup({ apiStatus: 403 });
    const res = await run(add({ url: VIOLATOR }));
    expect(res.status).toBe(201);
    expect(pages).toEqual(["/ch/album/665404621?l=en-GB"]);
  });

  it("finds a song's album from its page without the API", async () => {
    const { run, pages } = setup({ token: null });
    const res = await run(add({ url: "https://music.apple.com/ch/song/personal-jesus/665404702" }));
    expect(res.status).toBe(201);
    expect(pages).toEqual(["/ch/song/665404702?l=en-GB", "/ch/album/665404621?l=en-GB"]);
  });

  it("says not in store when the page is missing too", async () => {
    const { run } = setup({ token: null });
    expect((await run(add({ url: "https://music.apple.com/ch/album/hopes-and-fears/1440798025" }))).status).toBe(404);
  });

  it("validates the body", async () => {
    const { run } = setup();
    expect((await run(add({}))).status).toBe(400);
    expect((await run(add({ url: "x", source: "spam" }))).status).toBe(400);
    expect((await run(add({ url: "x", note: 5 }))).status).toBe(400);
    expect((await run(add({ url: "x", note: "a".repeat(2001) }))).status).toBe(400);
  });

  it("returns 502 when Apple refuses everything", async () => {
    const env: Env = { DB: createTestDb().d1, ASSETS: {} as Fetcher, STOREFRONT: "ch", ACCESS_TEAM_DOMAIN: "x", ACCESS_AUD: "y" };
    const res = await handle(add({ url: VIOLATOR }), env, {
      verify: async () => ME,
      fetch: (async () => new Response("down", { status: 503 })) as typeof fetch,
      musicToken: async () => "t",
      now: () => new Date(),
    });
    expect(res.status).toBe(502);
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });
});
