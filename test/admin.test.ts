import { describe, expect, it } from "vitest";
import { addAlbum } from "../src/albums.ts";
import { handle, type Deps, type Env } from "../src/app.ts";
import { parseMusicApiAlbum } from "../src/apple.ts";
import type { Identity } from "../src/auth.ts";
import { createTestDb } from "./helpers/d1.ts";
import { kickApi, violatorApi } from "./fixtures/apple.ts";

const OWNER: Identity = { email: "owner@example.com", serviceToken: null };
const BASE = "https://albums.gcameron.com";

async function setup(who: Identity | null = OWNER) {
  const { d1, sqlite } = createTestDb();
  // Violator is already listed; Kick is added through the form.
  await addAlbum(d1, parseMusicApiAlbum(violatorApi, "ch"), { note: "Side two.", source: "shortcut", now: "2026-11-08T10:00:00.000Z" });
  const env: Env = {
    DB: d1,
    ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
    STOREFRONT: "ch",
    ACCESS_TEAM_DOMAIN: "x",
    ACCESS_AUD: "y",
  };
  const deps: Deps = {
    verify: async () => who,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/catalog/ch/albums/1440855131") return Response.json(kickApi);
      return Response.json({ errors: [] }, { status: 404 });
    }) as typeof fetch,
    musicToken: async () => "t",
    now: () => new Date("2026-11-09T08:00:00Z"),
  };
  const run = (req: Request) => handle(req, env, deps);
  const get = (path: string, headers: Record<string, string> = {}) => run(new Request(BASE + path, { headers }));
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
    run(
      new Request(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const postJson = (path: string, body: unknown) =>
    run(new Request(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const violator = (sqlite.prepare("SELECT id FROM albums WHERE apple_id = '665404621'").get() as { id: number }).id;
  return { run, get, form, postJson, sqlite, violator };
}

describe("admin pages", () => {
  it("need Access", async () => {
    const { get, form } = await setup(null);
    expect((await get("/admin")).status).toBe(401);
    expect((await get("/admin/history")).status).toBe(401);
    expect((await form("/admin/albums", { url: "x" })).status).toBe(401);
  });

  it("show the add form, not indexed", async () => {
    const res = await (await setup()).get("/admin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain('<form class="admin-form" method="post" action="/admin/albums">');
    expect(html).toContain("Signed in as owner@example.com");
    expect(html).toContain('<a href="/admin" aria-current="page">Admin</a>');
  });
});

describe("adding from the form", () => {
  it("adds and redirects to the album page with a confirmation", async () => {
    const { form, get } = await setup();
    const res = await form("/admin/albums", { url: "https://music.apple.com/ch/album/kick-remastered/1440855131?l=en-GB", note: "Loud." });
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/albums\/\d+\?msg=created$/);
    const page = await (await get(location)).text();
    expect(page).toContain("Added to the list.");
    expect(page).toContain("<p>Loud.</p>");
  });

  it("shows errors on the form, keeping what was typed", async () => {
    const { form } = await setup();
    const res = await form("/admin/albums", { url: "https://open.spotify.com/album/x", note: "Keep <me>" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('class="flash error"');
    expect(html).toContain('value="https://open.spotify.com/album/x"');
    expect(html).toContain("Keep &lt;me&gt;</textarea>");
  });

  it("refuses forms posted from other sites", async () => {
    const { form } = await setup();
    const url = "https://music.apple.com/ch/album/kick-remastered/1440855131";
    expect((await form("/admin/albums", { url }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await form("/admin/albums", { url }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await form("/admin/albums", { url }, { origin: BASE })).status).toBe(303);
  });
});

describe("editing, removing and restoring", () => {
  it("edits the note", async () => {
    const { get, form, sqlite, violator } = await setup();
    expect(await (await get(`/admin/albums/${violator}`)).text()).toContain("Side two.</textarea>");
    const res = await form(`/admin/albums/${violator}`, { note: "  Side two, every time.  " });
    expect(res.headers.get("location")).toBe(`/albums/${violator}?msg=saved`);
    expect(sqlite.prepare("SELECT note FROM albums").get()).toEqual({ note: "Side two, every time." });
    expect(sqlite.prepare("SELECT action, detail FROM events ORDER BY id DESC").get()).toEqual({
      action: "edited",
      detail: '{"note":"Side two, every time."}',
    });
    await form(`/admin/albums/${violator}`, { note: "" });
    expect(sqlite.prepare("SELECT note FROM albums").get()).toEqual({ note: null });
  });

  it("removes into the private history and restores", async () => {
    const { get, form, sqlite, violator } = await setup();
    const removed = await form(`/admin/albums/${violator}/remove`, { reason: "Heard it <too> often" });
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/admin/history?msg=removed");
    expect(sqlite.prepare("SELECT status, removed_reason, removed_at FROM albums").get()).toEqual({
      status: "removed",
      removed_reason: "Heard it <too> often",
      removed_at: "2026-11-09T08:00:00.000Z",
    });

    // Gone from public pages, kept in the history.
    expect((await get(`/albums/${violator}`)).status).toBe(404);
    expect(await (await get("/")).text()).toContain("Nothing on the list yet.");
    const history = await (await get("/admin/history?msg=removed")).text();
    expect(history).toContain("Removed. It stays here and can be put back.");
    expect(history).toContain("Removed 9 Nov 2026: Heard it &lt;too&gt; often");
    expect(history).toContain(`action="/admin/albums/${violator}/restore"`);

    expect((await form(`/admin/albums/${violator}/remove`, {})).status).toBe(409);

    const restored = await form(`/admin/albums/${violator}/restore`, {});
    expect(restored.headers.get("location")).toBe(`/albums/${violator}?msg=restored`);
    expect(sqlite.prepare("SELECT status, removed_reason FROM albums").get()).toEqual({ status: "listed", removed_reason: null });
    expect(await (await get(`/albums/${violator}?msg=restored`)).text()).toContain("Back on the list.");
    expect(sqlite.prepare("SELECT action FROM events ORDER BY id").all()).toEqual([
      { action: "added" },
      { action: "removed" },
      { action: "restored" },
    ]);
  });

  it("takes JSON for the same actions", async () => {
    const { postJson, violator } = await setup();
    expect(await (await postJson(`/admin/albums/${violator}`, { note: "Via JSON", source: "mcp" })).json()).toMatchObject({
      outcome: "saved",
      album: { note: "Via JSON" },
    });
    expect(await (await postJson(`/admin/albums/${violator}/remove`, { reason: "test", source: "mcp" })).json()).toMatchObject({
      outcome: "removed",
      summary: "Removed: Depeche Mode – Violator (1990)",
    });
    expect((await postJson(`/admin/albums/${violator}/remove`, {})).status).toBe(409);
    expect(await (await postJson(`/admin/albums/${violator}/restore`, { source: "mcp" })).json()).toMatchObject({ outcome: "restored" });
    expect((await postJson(`/admin/albums/${violator}/restore`, {})).status).toBe(409);
    expect((await postJson("/admin/albums/999/remove", {})).status).toBe(404);
  });

  it("shows the history log", async () => {
    const { get, form, violator } = await setup();
    await form(`/admin/albums/${violator}`, { note: "New note" });
    const html = await (await get("/admin/history")).text();
    expect(html).toContain("Nothing removed.");
    expect(html).toContain("<td>Note edited</td>");
    expect(html).toContain("<td>Added</td>");
    expect(html).toContain('<td class="wide">shortcut</td>');
  });
});

describe("edit link on album pages", () => {
  it("appears only with an Access session cookie", async () => {
    const { get, violator } = await setup();
    expect(await (await get(`/albums/${violator}`)).text()).not.toContain("/admin/albums/");
    const withCookie = await get(`/albums/${violator}`, { cookie: "theme=dark; CF_Authorization=abc" });
    expect(await withCookie.text()).toContain(`<a href="/admin/albums/${violator}">Edit</a>`);
    expect(withCookie.headers.get("cache-control")).toBe("no-store");
  });
});
