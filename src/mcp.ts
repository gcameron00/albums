import { describe, findById, removeAlbum, restoreAlbum, setOriginalYear, updateNote, type AlbumRow } from "./albums.ts";
import { LinkError, LookupError } from "./apple.ts";
import { addFromLink, readYear } from "./admin.ts";
import type { Deps, Env } from "./app.ts";
import {
  facets,
  listAlbums,
  parseListQuery,
  randomAlbums,
  recentEvents,
  removedAlbums,
  SORTS,
  type ListQuery,
} from "./catalog.ts";
import { formatAlbumTime } from "./format.ts";
import { json } from "./http.ts";

/**
 * Remote MCP server (Streamable HTTP, stateless, JSON responses) at /mcp.
 * /mcp is behind the Albums admin Access application with Managed OAuth:
 * Access runs the OAuth flow for MCP clients (one-time PIN), checks the
 * token at the edge and forwards its JWT, which src/app.ts verifies like any
 * /admin request. So every caller is the owner and every tool may write.
 */

export const SERVER_INFO = { name: "albums", title: "Albums", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = "2025-06-18";

/**
 * Server instructions. The first two sentences are for routing: they tell a
 * client with several music connectors (Sonos, Last.fm, ...) when to use this
 * one. The search_albums and random_album descriptions repeat the cue, since
 * not every client passes server instructions to the model.
 */
const INSTRUCTIONS = `The user's curated personal album collection: albums worth playing start to finish \
(albums.gcameron.com). Use when the user refers to "my albums", "my album list/collection", or wants \
recommendations, random picks or suggestions drawn from their own albums (not their listening history). \
Search by artist or title, filter by decade or genre, pick at random; add from an Apple Music link, edit \
notes, set original years, remove (kept in a private history) and restore. No ranking: every album is a \
favourite. Each album has an Apple Music URL for playback.`;

/** The person Access identified. */
export interface McpProps {
  email: string;
}

// ---------------------------------------------------------------------------
// Tools

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: Args, env: Env, deps: Deps): Promise<unknown>;
}

/** Wrong or missing arguments: reported to the model as a tool error. */
class ToolError extends Error {}

const SITE = "https://albums.gcameron.com";

function albumOut(a: AlbumRow, full = false) {
  const base = {
    id: a.id,
    title: a.title,
    artist: a.artist,
    year: a.year,
    genre: a.genre,
    tracks: a.track_count,
    length: formatAlbumTime(a.duration_ms) || null,
    note: a.note,
    apple_url: a.apple_url,
    page: `${SITE}/albums/${a.id}`,
    added: a.added_at.slice(0, 10),
  };
  if (!full) return base;
  return {
    ...base,
    apple_id: a.apple_id,
    original_year: a.original_year,
    edition: a.edition,
    edition_release_date: a.release_date,
    artwork: a.artwork_url ? a.artwork_url.replace("{w}x{h}", "600x600") : null,
    status: a.status,
    removed_at: a.removed_at,
    removed_reason: a.removed_reason,
    added_via: a.source,
  };
}

const str = (args: Args, key: string): string | undefined => {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolError(`${key} must be a string.`);
  return v;
};
const int = (args: Args, key: string): number | undefined => {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolError(`${key} must be an integer.`);
  return v;
};
const requiredId = (args: Args): number => {
  const id = int(args, "id");
  if (id === undefined || id < 1) throw new ToolError("id is required (a positive integer from search_albums).");
  return id;
};

/** Filters shared by search_albums and random_album, as list query parameters. */
function listQuery(args: Args, extra: Record<string, string> = {}): ListQuery {
  const p = new URLSearchParams(extra);
  const query = str(args, "query");
  const artist = str(args, "artist");
  const genre = str(args, "genre");
  const decade = int(args, "decade");
  if (query) p.set("q", query);
  if (artist) p.set("artist", artist);
  if (genre) p.set("genre", genre);
  if (decade !== undefined) {
    if (decade % 10 !== 0) throw new ToolError("decade must be the first year of a decade, e.g. 1980.");
    p.set("decade", String(decade));
  }
  return parseListQuery(p);
}

const FILTER_PROPS = {
  query: { type: "string", description: "Words in the artist name or album title (not track names)." },
  artist: { type: "string", description: "Exact artist name, as returned by other tools." },
  decade: { type: "integer", description: "First year of a decade, e.g. 1980 for the 1980s." },
  genre: { type: "string", description: "Exact genre, as listed by get_stats." },
};

async function loadAlbum(env: Env, id: number): Promise<AlbumRow> {
  const album = await findById(env.DB, id);
  if (!album) throw new ToolError(`No album with id ${id}.`);
  return album;
}

const now = (deps: Deps) => deps.now().toISOString();

export const TOOLS: Tool[] = [
  {
    name: "search_albums",
    title: "Search albums",
    description:
      "List albums in the user's own album collection (\"my albums\"), optionally filtered by words in the artist or title, exact artist, decade or genre. " +
      "With no arguments, lists the most recently added. Returns up to 200 per page with the total count.",
    inputSchema: {
      type: "object",
      properties: {
        ...FILTER_PROPS,
        sort: { type: "string", enum: Object.keys(SORTS), description: "added (newest first), artist, year or title. Default added." },
        direction: { type: "string", enum: ["asc", "desc"], description: "Overrides the sort's default direction." },
        page: { type: "integer", minimum: 1, description: "Page number, from 1." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, env) {
      const extra: Record<string, string> = { view: "list" };
      const sort = str(args, "sort");
      const dir = str(args, "direction");
      const page = int(args, "page");
      if (sort) extra.sort = sort;
      if (dir) extra.dir = dir;
      if (page) extra.page = String(page);
      const q = listQuery(args, extra);
      const result = await listAlbums(env.DB, q);
      return { total: result.total, page: q.page, page_size: 200, albums: result.albums.map((a) => albumOut(a)) };
    },
  },
  {
    name: "get_album",
    title: "Get an album",
    description: "Everything about one album by id, including a removed one (status, removal date and reason).",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, env) {
      return albumOut(await loadAlbum(env, requiredId(args)), true);
    },
  },
  {
    name: "random_album",
    title: "Pick something to play",
    description:
      "Pick one or more random albums from the user's own album collection, for \"what should I play?\" or suggestions from \"my albums\". " +
      "Optionally within the same filters as search_albums.",
    inputSchema: {
      type: "object",
      properties: { ...FILTER_PROPS, count: { type: "integer", minimum: 1, maximum: 10, description: "How many to pick (default 1)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, env) {
      const count = Math.min(Math.max(int(args, "count") ?? 1, 1), 10);
      const albums = await randomAlbums(env.DB, listQuery(args), count);
      return { albums: albums.map((a) => albumOut(a)) };
    },
  },
  {
    name: "get_stats",
    title: "List statistics",
    description: "Totals for the list: albums and listening time, counts by decade and genre, artists with more than one album, additions per month.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(_args, env) {
      const [f, time, artists, months] = await Promise.all([
        facets(env.DB),
        env.DB.prepare("SELECT SUM(duration_ms) AS ms FROM albums WHERE status = 'listed'").first<{ ms: number | null }>(),
        env.DB
          .prepare(
            "SELECT artist, COUNT(*) AS albums FROM albums WHERE status = 'listed' GROUP BY artist HAVING COUNT(*) > 1 ORDER BY albums DESC, artist",
          )
          .all<{ artist: string; albums: number }>(),
        env.DB
          .prepare(
            "SELECT substr(added_at, 1, 7) AS month, COUNT(*) AS added FROM albums WHERE status = 'listed' GROUP BY month ORDER BY month",
          )
          .all<{ month: string; added: number }>(),
      ]);
      return {
        albums: f.total,
        total_length: formatAlbumTime(time?.ms ?? null) || null,
        by_decade: f.decades.map((d) => ({ decade: `${d.decade}s`, albums: d.n })),
        by_genre: f.genres.map((g) => ({ genre: g.genre, albums: g.n })),
        artists_with_several_albums: artists.results ?? [],
        added_per_month: months.results ?? [],
      };
    },
  },
  {
    name: "list_history",
    title: "Removed albums and changes",
    description: "Private history: removed albums with dates and reasons, and the latest changes (added, removed, put back, note edited).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: "How many changes (default 50)." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, env) {
      const limit = Math.min(Math.max(int(args, "limit") ?? 50, 1), 200);
      const [removed, events] = await Promise.all([removedAlbums(env.DB), recentEvents(env.DB, limit)]);
      return {
        removed: removed.map((a) => ({ id: a.id, title: a.title, artist: a.artist, removed_at: a.removed_at, reason: a.removed_reason })),
        changes: events.map((ev) => ({
          at: ev.at,
          action: ev.action,
          album_id: ev.album_id,
          title: ev.title,
          artist: ev.artist,
          via: ev.source,
          detail: ev.detail ? (JSON.parse(ev.detail) as unknown) : null,
        })),
      };
    },
  },
  {
    name: "add_album",
    title: "Add an album",
    description:
      "Add an album from an Apple Music album (or song) link, e.g. https://music.apple.com/ch/album/violator/665404621. " +
      "Reports when it is already listed, and puts it back if it had been removed. Only for albums worth playing start to finish.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Apple Music album or song link (Swiss store)." },
        note: { type: "string", maxLength: 2000, description: "Optional public note: why it is on the list." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(args, env, deps) {
      const url = str(args, "url");
      if (!url) throw new ToolError("url is required.");
      const note = str(args, "note")?.trim() || null;
      if (note && note.length > 2000) throw new ToolError("note is longer than 2000 characters.");
      const result = await addFromLink(env, deps, url, note, "mcp");
      return { outcome: result.outcome, summary: result.summary, album: albumOut(result.album) };
    },
  },
  {
    name: "update_note",
    title: "Edit an album's note",
    description: "Set the public note on an album, or clear it with an empty string.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, note: { type: "string", maxLength: 2000 } },
      required: ["id", "note"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, env, deps) {
      const album = await loadAlbum(env, requiredId(args));
      if (typeof args.note !== "string") throw new ToolError("note is required (empty string clears it).");
      const note = args.note.trim();
      if (note.length > 2000) throw new ToolError("note is longer than 2000 characters.");
      const updated = await updateNote(env.DB, album, note || null, { source: "mcp", now: now(deps) });
      return { summary: `Note ${note ? "saved" : "cleared"}: ${describe(updated)}`, album: albumOut(updated) };
    },
  },
  {
    name: "set_original_year",
    title: "Set an album's original year",
    description:
      "Set the year an album was first released, when Apple's date is a reissue's (e.g. a remaster). " +
      "It becomes the year shown, sorted and filtered on. Pass null to go back to Apple's year.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        original_year: { type: ["integer", "null"], minimum: 1900, description: "e.g. 1987, or null to clear." },
      },
      required: ["id", "original_year"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, env, deps) {
      const album = await loadAlbum(env, requiredId(args));
      if (!("original_year" in args)) throw new ToolError("original_year is required (null clears it).");
      const year = readYear(args.original_year, deps.now());
      if ("error" in year) throw new ToolError(year.error);
      const updated = await setOriginalYear(env.DB, album, year.value, { source: "mcp", now: now(deps) });
      return {
        summary: year.value === null ? `Original year cleared: ${describe(updated)}` : `Original year set: ${describe(updated)}`,
        album: albumOut(updated, true),
      };
    },
  },
  {
    name: "remove_album",
    title: "Remove an album",
    description: "Take an album off the list. It moves to the private history (see list_history) and can be restored.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, reason: { type: "string", maxLength: 500, description: "Optional, private." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async run(args, env, deps) {
      const album = await loadAlbum(env, requiredId(args));
      if (album.status === "removed") return { summary: `Already removed: ${describe(album)}` };
      const reason = str(args, "reason")?.trim() || null;
      if (reason && reason.length > 500) throw new ToolError("reason is longer than 500 characters.");
      const removed = await removeAlbum(env.DB, album, reason, { source: "mcp", now: now(deps) });
      return { summary: `Removed: ${describe(removed)}`, id: removed.id };
    },
  },
  {
    name: "restore_album",
    title: "Put an album back",
    description: "Put a removed album back on the list.",
    inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async run(args, env, deps) {
      const album = await loadAlbum(env, requiredId(args));
      if (album.status === "listed") return { summary: `Already on the list: ${describe(album)}`, album: albumOut(album) };
      const result = await restoreAlbum(env.DB, album, { note: null, source: "mcp", now: now(deps) });
      return { summary: result.summary, album: albumOut(result.album) };
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(params: Record<string, unknown>, env: Env, deps: Deps): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return null;
  const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Args;
  try {
    const out = await tool.run(args, env, deps);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false };
  } catch (error) {
    if (error instanceof ToolError || error instanceof LinkError || error instanceof LookupError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    console.error("MCP tool failed", tool.name, String(error));
    return { content: [{ type: "text", text: "The tool failed unexpectedly. Try again." }], isError: true };
  }
}

async function dispatch(msg: RpcRequest, env: Env, deps: Deps): Promise<unknown> {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : LATEST;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const result = await callTool(msg.params ?? {}, env, deps);
      return result === null ? rpcError(id, -32602, `Unknown tool: ${String(msg.params?.name)}`) : rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/** /mcp: one JSON-RPC message per POST; notifications get 202. No SSE stream. */
export async function mcp(request: Request, env: Env, deps: Deps, props: McpProps | undefined): Promise<Response> {
  if (!props?.email) return json({ error: "Not authorised." }, 401);
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let msg: unknown;
  try {
    msg = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(msg)) return json(rpcError(null, -32600, "Batches are not supported."), 400);
  const m = msg as Partial<RpcRequest>;
  if (typeof m !== "object" || m === null || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    // A response or something else the server did not ask for.
    if (typeof m === "object" && m !== null && ("result" in m || "error" in m)) return new Response(null, { status: 202 });
    return json(rpcError(null, -32600, "Invalid request"), 400);
  }
  if (m.id === undefined) return new Response(null, { status: 202 }); // notification
  return json(await dispatch(m as RpcRequest, env, deps));
}
