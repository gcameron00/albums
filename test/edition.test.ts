import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { addAlbum } from "../src/albums.ts";
import { handle, type Deps, type Env } from "../src/app.ts";
import { parseAlbumPage, parseMusicApiAlbum } from "../src/apple.ts";
import type { Identity } from "../src/auth.ts";
import { splitEdition } from "../src/edition.ts";
import { mcp } from "../src/mcp.ts";
import { createTestDb } from "./helpers/d1.ts";
import { kickApi, violatorApi, violatorPage } from "./fixtures/apple.ts";

describe("splitEdition", () => {
  it("takes edition labels out of titles", () => {
    expect(splitEdition("Kick ((Remastered))")).toEqual({ title: "Kick", edition: "Remastered" });
    expect(splitEdition("Kick (Remastered)")).toEqual({ title: "Kick", edition: "Remastered" });
    expect(splitEdition("Rumours (Super Deluxe)")).toEqual({ title: "Rumours", edition: "Super Deluxe" });
    expect(splitEdition("Violator [2006 Remaster]")).toEqual({ title: "Violator", edition: "2006 Remaster" });
    expect(splitEdition("Hunky Dory - 2015 Remaster")).toEqual({ title: "Hunky Dory", edition: "2015 Remaster" });
    expect(splitEdition("Disintegration (Deluxe Edition) [Remastered]")).toEqual({
      title: "Disintegration",
      edition: "Deluxe Edition · Remastered",
    });
    expect(splitEdition("OK Computer (Collector's Edition)")).toEqual({ title: "OK Computer", edition: "Collector's Edition" });
  });

  it("leaves other brackets and dashes alone", () => {
    expect(splitEdition("(What's the Story) Morning Glory?")).toEqual({ title: "(What's the Story) Morning Glory?", edition: null });
    expect(splitEdition("Red (Taylor's Version)")).toEqual({ title: "Red (Taylor's Version)", edition: null });
    expect(splitEdition("Live - Cologne 1975")).toEqual({ title: "Live - Cologne 1975", edition: null });
    expect(splitEdition("Hopes and Fears")).toEqual({ title: "Hopes and Fears", edition: null });
    expect(splitEdition("(Remastered)")).toEqual({ title: "(Remastered)", edition: null });
  });

  it("is applied to both Apple sources", () => {
    expect(parseMusicApiAlbum(kickApi, "ch")).toMatchObject({ title: "Kick", edition: "Remastered" });
    const page = violatorPage.replace('"name":"Violator"', '"name":"Violator ((Remastered))"');
    expect(parseAlbumPage(page, "665404621", "ch")).toMatchObject({ title: "Violator", edition: "Remastered" });
  });
});

describe("migration 0003", () => {
  it("splits Remastered off titles already stored", () => {
    const db = new DatabaseSync(":memory:");
    const dir = join(import.meta.dirname, "..", "migrations");
    db.exec(readFileSync(join(dir, "0001_init.sql"), "utf8"));
    db.exec(readFileSync(join(dir, "0002_drop_tracks.sql"), "utf8"));
    const insert = db.prepare(
      "INSERT INTO albums (apple_id, title, artist, apple_url, added_at, source, year) VALUES (?, ?, 'X', 'u', 't', 'web', 2013)",
    );
    insert.run("1", "Kick ((Remastered))");
    insert.run("2", "Kick (Remastered)");
    insert.run("3", "Violator");
    db.exec(readFileSync(join(dir, "0003_original_year_edition.sql"), "utf8"));
    expect(db.prepare("SELECT title, edition, original_year, year FROM albums ORDER BY apple_id").all().map((r) => ({ ...(r as object) }))).toEqual([
      { title: "Kick", edition: "Remastered", original_year: null, year: 2013 },
      { title: "Kick", edition: "Remastered", original_year: null, year: 2013 },
      { title: "Violator", edition: null, original_year: null, year: 2013 },
    ]);
  });
});

describe("original year", () => {
  const OWNER: Identity = { email: "owner@example.com", serviceToken: null };
  const BASE = "https://albums.gcameron.com";

  async function setup() {
    const { d1, sqlite } = createTestDb();
    const reissue = { ...parseMusicApiAlbum(kickApi, "ch"), releaseDate: "2013-01-01", year: 2013 };
    await addAlbum(d1, reissue, { note: null, source: "shortcut", now: "2026-11-08T10:00:00.000Z" });
    await addAlbum(d1, parseMusicApiAlbum(violatorApi, "ch"), { note: null, source: "web", now: "2026-11-08T11:00:00.000Z" });
    const env: Env = {
      DB: d1,
      ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
      STOREFRONT: "ch",
      ACCESS_TEAM_DOMAIN: "x",
      ACCESS_AUD: "y",
    };
    const deps: Deps = {
      verify: async () => OWNER,
      fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
      musicToken: async () => null,
      now: () => new Date("2026-11-09T08:00:00Z"),
    };
    const kick = (sqlite.prepare("SELECT id FROM albums WHERE apple_id = '1440855131'").get() as { id: number }).id;
    const get = async (path: string) => (await handle(new Request(BASE + path), env, deps)).text();
    const form = (path: string, body: string) =>
      handle(
        new Request(BASE + path, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
          body,
        }),
        env,
        deps,
      );
    return { env, deps, sqlite, kick, get, form };
  }

  const row = (sqlite: DatabaseSync, id: number) => ({ ...(sqlite.prepare("SELECT year, original_year FROM albums WHERE id = ?").get(id) as object) });

  it("shows the edition only on the album page", async () => {
    const { get, kick } = await setup();
    const page = await get(`/albums/${kick}`);
    expect(page).toContain("<h1>Kick</h1>");
    expect(page).toContain('<p class="edition">This edition: Remastered</p>');
    expect(await get("/")).not.toContain("Remastered");
  });

  it("is set and cleared from the edit page, and drives year sorting and filters", async () => {
    const { get, form, sqlite, kick } = await setup();
    expect(await get(`/admin/albums/${kick}`)).toContain("(Apple: 2013, Remastered)");

    const saved = await form(`/admin/albums/${kick}/year`, "original_year=1987");
    expect(saved.headers.get("location")).toBe(`/admin/albums/${kick}?msg=year`);
    expect(row(sqlite, kick)).toEqual({ year: 1987, original_year: 1987 });
    expect(await get(`/admin/albums/${kick}?msg=year`)).toContain("Original year saved.");
    expect(await get(`/albums/${kick}`)).toContain("This edition: Remastered, released 2013");
    expect(await get("/?decade=1980")).toContain("<span class=\"title\">Kick</span>");
    expect(sqlite.prepare("SELECT detail FROM events ORDER BY id DESC").get()).toEqual({ detail: '{"original_year":1987}' });
    expect(await get("/admin/history")).toContain("Original year 1987");

    await form(`/admin/albums/${kick}/year`, "original_year=");
    expect(row(sqlite, kick)).toEqual({ year: 2013, original_year: null });
  });

  it("rejects years that are not plausible", async () => {
    const { form, sqlite, kick } = await setup();
    for (const bad of ["1850", "2099", "87", "abc"]) {
      expect((await form(`/admin/albums/${kick}/year`, `original_year=${bad}`)).status).toBe(400);
    }
    expect(row(sqlite, kick)).toEqual({ year: 2013, original_year: null });
  });

  it("is in the public API and set through MCP", async () => {
    const { env, deps, sqlite, kick } = await setup();
    const call = async (args: Record<string, unknown>) => {
      const res = await mcp(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_original_year", arguments: args } }),
        }),
        env,
        deps,
        { email: "owner@example.com" },
      );
      return ((await res.json()) as { result: { isError: boolean; structuredContent?: any } }).result;
    };
    expect((await call({ id: kick, original_year: 1987 })).structuredContent).toMatchObject({
      summary: "Original year set: INXS – Kick (1987)",
      album: { year: 1987, original_year: 1987, edition: "Remastered", edition_release_date: "2013-01-01" },
    });
    expect((await call({ id: kick, original_year: 1066 })).isError).toBe(true);
    expect((await call({ id: kick })).isError).toBe(true);
    const api = (await (await handle(new Request(`${BASE}/api/albums/${kick}`), env, deps)).json()) as Record<string, unknown>;
    expect(api).toMatchObject({ title: "Kick", year: 1987, original_year: 1987, edition: "Remastered", release_date: "2013-01-01" });
    expect((await call({ id: kick, original_year: null })).structuredContent.summary).toBe("Original year cleared: INXS – Kick (2013)");
    expect(row(sqlite, kick)).toEqual({ year: 2013, original_year: null });
  });
});
