import { describe, expect, it } from "vitest";
import { handle, type Deps, type Env } from "../src/app.ts";
import type { Identity } from "../src/auth.ts";
import { escapeHtml } from "../src/html.ts";
import { createTestDb } from "./helpers/d1.ts";
import { empty, kick, personalJesusSong, violator } from "./fixtures/lookup.ts";

const ME: Identity = { email: "me@gcameron.com", serviceToken: null };

function setup(opts: { who?: Identity | null; answers?: Record<string, unknown> } = {}) {
  const { d1, sqlite } = createTestDb();
  const env: Env = {
    DB: d1,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    STOREFRONT: "ch",
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "aud",
  };
  const lookups: string[] = [];
  const userAgents: Array<string | null> = [];
  const answers = opts.answers ?? {
    "665404621": violator,
    "665404702": personalJesusSong,
    "1440855131": kick,
  };
  const deps: Deps = {
    verify: async () => (opts.who === undefined ? ME : opts.who),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      userAgents.push(new Headers(init?.headers).get("user-agent"));
      lookups.push(url.search);
      const id = url.searchParams.get("id") ?? "";
      return Response.json(answers[id] ?? empty);
    }) as typeof fetch,
    now: () => new Date("2026-11-08T16:00:00Z"),
  };
  const run = (req: Request) => handle(req, env, deps);
  return { run, sqlite, lookups, userAgents };
}

const get = (path: string) => new Request(`https://albums.gcameron.com${path}`);
const add = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://albums.gcameron.com/admin/albums", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("public routes", () => {
  it("answers /health", async () => {
    const res = await setup().run(get("/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("renders the home page with the album count", async () => {
    const { run } = setup();
    expect(await (await run(get("/"))).text()).toContain("0 albums so far");
    await run(add({ url: "https://music.apple.com/ch/album/violator/665404621?l=en-GB" }));
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
  it("adds an album with its tracks and an event", async () => {
    const { run, sqlite, lookups, userAgents } = setup();
    const res = await run(
      add({ url: "https://music.apple.com/ch/album/violator/665404621?l=en-GB", note: "  Side two!  ", source: "shortcut" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { outcome: string; summary: string; album: Record<string, unknown> };
    expect(body.outcome).toBe("created");
    expect(body.summary).toBe("Added: Depeche Mode – Violator (1990)");
    expect(body.album).toMatchObject({ title: "Violator", year: 1990, note: "Side two!" });
    expect(lookups).toEqual(["?id=665404621&country=ch&entity=song"]);
    expect(userAgents).toEqual(["albums.gcameron.com/1.0 (+https://albums.gcameron.com)"]);

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tracks").get()).toEqual({ n: 9 });
    expect(sqlite.prepare("SELECT action, source, at FROM events").all()).toEqual([
      { action: "added", source: "shortcut", at: "2026-11-08T16:00:00.000Z" },
    ]);
  });

  it("reports a duplicate without asking Apple again", async () => {
    const { run, lookups } = setup();
    await run(add({ url: "https://music.apple.com/ch/album/violator/665404621" }));
    const res = await run(add({ url: "https://music.apple.com/ch/album/violator/665404621?l=en-GB" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "duplicate", summary: "Already on the list: Depeche Mode – Violator (1990)" });
    expect(lookups).toHaveLength(1);
  });

  it("restores a removed album", async () => {
    const { run, sqlite } = setup();
    await run(add({ url: "https://music.apple.com/ch/album/violator/665404621" }));
    sqlite.exec("UPDATE albums SET status = 'removed', removed_at = 'x', removed_reason = 'tired of it'");
    const res = await run(add({ url: "https://music.apple.com/ch/album/violator/665404621" }));
    expect(await res.json()).toMatchObject({ outcome: "restored", summary: "Restored from history: Depeche Mode – Violator (1990)" });
    expect(sqlite.prepare("SELECT status, removed_reason FROM albums").get()).toEqual({ status: "listed", removed_reason: null });
    expect(sqlite.prepare("SELECT action FROM events ORDER BY id").all()).toEqual([{ action: "added" }, { action: "restored" }]);
  });

  it("finds the album from a song link", async () => {
    const { run } = setup();
    const res = await run(add({ url: "https://music.apple.com/ch/song/personal-jesus/665404702" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ album: { apple_id: "665404621" } });
  });

  it("explains bad links and albums missing from the Swiss store", async () => {
    const { run } = setup();
    const bad = await run(add({ url: "https://music.apple.com/ch/playlist/x/pl.123" }));
    expect(bad.status).toBe(400);
    const missing = await run(add({ url: "https://music.apple.com/ch/album/hopes-and-fears/1440798025" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ summary: "That album is not available in the CH Apple Music store." });
  });

  it("validates the body", async () => {
    const { run } = setup();
    expect((await run(add({}))).status).toBe(400);
    expect((await run(add({ url: "x", source: "spam" }))).status).toBe(400);
    expect((await run(add({ url: "x", note: 5 }))).status).toBe(400);
    expect((await run(add({ url: "x", note: "a".repeat(2001) }))).status).toBe(400);
  });

  it("returns 502 when Apple fails", async () => {
    const failing = handle(
      add({ url: "https://music.apple.com/ch/album/violator/665404621" }),
      {
        DB: createTestDb().d1,
        ASSETS: {} as Fetcher,
        STOREFRONT: "ch",
        ACCESS_TEAM_DOMAIN: "x",
        ACCESS_AUD: "y",
      },
      { verify: async () => ME, fetch: (async () => new Response("down", { status: 503 })) as typeof fetch, now: () => new Date() },
    );
    expect((await failing).status).toBe(502);
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });
});
