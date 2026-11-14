import { describe, expect, it } from "vitest";
import { addAlbum } from "../src/albums.ts";
import { handle, type Deps, type Env } from "../src/app.ts";
import { parseMusicApiAlbum } from "../src/apple.ts";
import type { Identity } from "../src/auth.ts";
import { mcp, TOOLS } from "../src/mcp.ts";
import { createTestDb } from "./helpers/d1.ts";
import { kickApi, violatorApi } from "./fixtures/apple.ts";

const OWNER: Identity = { email: "owner@example.com", serviceToken: null };
const BASE = "https://albums.gcameron.com";

async function setup() {
  const { d1, sqlite } = createTestDb();
  await addAlbum(d1, parseMusicApiAlbum(violatorApi, "ch"), { note: "Side two.", source: "web", now: "2026-11-08T10:00:00.000Z" });
  const env: Env = {
    DB: d1,
    ASSETS: { fetch: async () => new Response("", { status: 404 }) } as unknown as Fetcher,
    STOREFRONT: "ch",
    ACCESS_TEAM_DOMAIN: "x",
    ACCESS_AUD: "y",
  };
  const deps: Deps = {
    verify: async () => OWNER,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/catalog/ch/albums/1440855131") return Response.json(kickApi);
      return Response.json({ errors: [] }, { status: 404 });
    }) as typeof fetch,
    musicToken: async () => "t",
    now: () => new Date("2026-11-09T08:00:00Z"),
  };
  let nextId = 1;
  const rpc = async (method: string, params?: unknown) => {
    const res = await mcp(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      }),
      env,
      deps,
      { email: "owner@example.com" },
    );
    return { status: res.status, body: (res.status === 200 ? await res.json() : null) as Record<string, any> | null };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { body } = await rpc("tools/call", { name, arguments: args });
    const result = body!.result as { isError: boolean; structuredContent?: any; content: Array<{ text: string }> };
    return result;
  };
  const violator = (sqlite.prepare("SELECT id FROM albums").get() as { id: number }).id;
  return { env, deps, rpc, call, sqlite, violator };
}

describe("MCP protocol", () => {
  it("initialises, echoing a supported protocol version", async () => {
    const { rpc } = await setup();
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(body!.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "albums" }, capabilities: { tools: {} } });
    const old = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(old.body!.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists tools with schemas and hints", async () => {
    const { rpc } = await setup();
    const { body } = await rpc("tools/list");
    const tools = body!.result.tools as Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }>;
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.find((t) => t.name === "search_albums")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "remove_album")!.annotations.readOnlyHint).toBe(false);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("answers notifications with 202 and unknown methods with an error", async () => {
    const { env, deps, rpc } = await setup();
    const note = await mcp(
      new Request(`${BASE}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      env,
      deps,
      { email: "owner@example.com" },
    );
    expect(note.status).toBe(202);
    expect((await rpc("resources/list")).body!.error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope" })).body!.error.code).toBe(-32602);
    expect((await mcp(new Request(`${BASE}/mcp`), env, deps, { email: "owner@example.com" })).status).toBe(405);
    expect((await mcp(new Request(`${BASE}/mcp`, { method: "POST", body: "{" }), env, deps, { email: "a" })).status).toBe(400);
  });

  it("refuses requests without an approved owner", async () => {
    const { env, deps } = await setup();
    const req = new Request(`${BASE}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await mcp(req, env, deps, undefined)).status).toBe(401);
  });
});

describe("MCP tools", () => {
  it("searches, gets and picks albums", async () => {
    const { call, violator } = await setup();
    const search = await call("search_albums", { query: "viol" });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({ total: 1, albums: [{ id: violator, title: "Violator", artist: "Depeche Mode", year: 1990 }] });
    expect(search.content[0]!.text).toContain('"title": "Violator"');
    expect((await call("search_albums", { decade: 1980 })).structuredContent.total).toBe(0);
    expect((await call("get_album", { id: violator })).structuredContent).toMatchObject({ status: "listed", note: "Side two.", added_via: "web" });
    expect((await call("random_album", { genre: "Alternative" })).structuredContent.albums).toHaveLength(1);
    expect((await call("random_album", { genre: "Jazz" })).structuredContent.albums).toHaveLength(0);
  });

  it("reports bad arguments as tool errors", async () => {
    const { call } = await setup();
    expect(await call("get_album", { id: 999 })).toMatchObject({ isError: true, content: [{ text: "No album with id 999." }] });
    expect((await call("get_album", {})).isError).toBe(true);
    expect((await call("search_albums", { decade: 1985 })).isError).toBe(true);
    expect((await call("add_album", { url: "https://open.spotify.com/album/x" })).isError).toBe(true);
  });

  it("adds, edits, removes and restores, logged as mcp", async () => {
    const { call, sqlite, violator } = await setup();
    const added = await call("add_album", { url: "https://music.apple.com/ch/album/kick-remastered/1440855131", note: "Loud." });
    expect(added.structuredContent).toMatchObject({ outcome: "created", summary: "Added: INXS – Kick (1987)" });
    expect((await call("add_album", { url: "https://music.apple.com/ch/album/kick-remastered/1440855131" })).structuredContent.outcome).toBe(
      "duplicate",
    );
    expect((await call("update_note", { id: violator, note: "" })).structuredContent.summary).toBe("Note cleared: Depeche Mode – Violator (1990)");
    expect((await call("remove_album", { id: violator, reason: "test" })).structuredContent.summary).toBe("Removed: Depeche Mode – Violator (1990)");
    expect((await call("remove_album", { id: violator })).structuredContent.summary).toBe("Already removed: Depeche Mode – Violator (1990)");
    const history = (await call("list_history")).structuredContent;
    expect(history.removed).toEqual([{ id: violator, title: "Violator", artist: "Depeche Mode", removed_at: "2026-11-09T08:00:00.000Z", reason: "test" }]);
    expect(history.changes[0]).toMatchObject({ action: "removed", via: "mcp", detail: { reason: "test" } });
    expect((await call("restore_album", { id: violator })).structuredContent.summary).toBe(
      "Restored from history: Depeche Mode – Violator (1990)",
    );
    expect(sqlite.prepare("SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY source").all()).toEqual([
      { source: "mcp", n: 4 },
      { source: "web", n: 1 },
    ]);
  });

  it("summarises the list", async () => {
    const { call } = await setup();
    expect((await call("get_stats")).structuredContent).toMatchObject({
      albums: 1,
      total_length: "37 min",
      by_decade: [{ decade: "1990s", albums: 1 }],
      by_genre: [{ genre: "Alternative", albums: 1 }],
      added_per_month: [{ month: "2026-11", added: 1 }],
    });
  });
});

describe("/mcp behind Access", () => {
  const post = (body: unknown) =>
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });

  it("serves a person Access identified", async () => {
    const { env, deps } = await setup();
    const res = await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, deps);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });

  it("refuses requests without an Access identity, and service tokens", async () => {
    const { env, deps } = await setup();
    const nobody = { ...deps, verify: async () => null };
    expect((await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, nobody)).status).toBe(401);
    const token = { ...deps, verify: async (): Promise<Identity> => ({ email: null, serviceToken: "abc.access" }) };
    expect((await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, token)).status).toBe(403);
  });

  it("logs changes as made through MCP", async () => {
    const { env, deps, sqlite, violator } = await setup();
    await handle(post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_note", arguments: { id: violator, note: "x" } } }), env, deps);
    expect(sqlite.prepare("SELECT source FROM events ORDER BY id DESC").get()).toEqual({ source: "mcp" });
  });
});

describe("MCP routing text", () => {
  it("tells clients this is the user's own album collection", async () => {
    const { rpc } = await setup();
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18" })).body!.result as { instructions: string };
    expect(init.instructions).toContain("The user's curated personal album collection");
    expect(init.instructions).toContain('"my albums"');
    const tools = (await rpc("tools/list")).body!.result.tools as Array<{ name: string; description: string }>;
    for (const name of ["search_albums", "random_album"]) {
      expect(tools.find((t) => t.name === name)!.description).toContain("the user's own album collection");
    }
  });
});
