import { addAlbum, describe, findByAppleId, restoreAlbum, SOURCES, type AlbumRow, type Source } from "./albums.ts";
import { albumIdFor, fetchAlbum, LinkError, LookupError, parseAppleMusicLink } from "./apple.ts";
import type { AuthEnv, Identity } from "./auth.ts";
import { escapeHtml, page } from "./html.ts";

export interface Env extends AuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  STOREFRONT: string;
}

/** What the handler needs from outside, so tests can replace it. */
export interface Deps {
  verify(request: Request, env: Env): Promise<Identity | null>;
  fetch: typeof fetch;
  now(): Date;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const MAX_BODY_BYTES = 8192;
const MAX_NOTE_CHARS = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
  });
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

/** Public shape of an album in API answers (no removal details). */
function publicAlbum(a: AlbumRow) {
  return {
    id: a.id,
    apple_id: a.apple_id,
    title: a.title,
    artist: a.artist,
    year: a.year,
    release_date: a.release_date,
    genre: a.genre,
    track_count: a.track_count,
    duration_ms: a.duration_ms,
    artwork_url: a.artwork_url,
    apple_url: a.apple_url,
    note: a.note,
    added_at: a.added_at,
  };
}

async function listedCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM albums WHERE status = 'listed'").first<{ n: number }>();
  return row?.n ?? 0;
}

function homePage(count: number): string {
  const label = count === 1 ? "1 album" : `${count} albums`;
  return page(
    "Albums",
    `    <h1>Albums</h1>
    <p>Albums worth playing from start to finish.</p>
    <p>${escapeHtml(label)} so far. The list is on its way.</p>`,
  );
}

function adminPage(who: Identity): string {
  const name = who.email ?? (who.serviceToken ? `service token ${who.serviceToken}` : "unknown");
  return page(
    "Albums admin",
    `    <h1>Albums admin</h1>
    <p>Signed in as ${escapeHtml(name)}.</p>
    <p><a href="/">Back to the list</a></p>`,
  );
}

/**
 * Browsers mark cross-site requests in Sec-Fetch-Site; refuse those. The
 * Shortcut and curl send no such header. A JSON body also needs a CORS
 * preflight cross-site, which this Worker never grants.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  if (crossSite(request)) return json({ error: "Cross-site requests are not allowed." }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Send JSON (Content-Type: application/json)." }, 415);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "Request body too large." }, 413);
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  return json({ error: "The body must be a JSON object." }, 400);
}

function readNote(value: unknown): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return json({ error: "note must be text." }, 400);
  const note = value.trim();
  if (note.length > MAX_NOTE_CHARS) return json({ error: `note is longer than ${MAX_NOTE_CHARS} characters.` }, 400);
  return note === "" ? null : note;
}

/** POST /admin/albums {url, note?, source?} */
async function addFromLink(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  if (typeof body.url !== "string") return json({ error: "url is required." }, 400);
  const note = readNote(body.note);
  if (note instanceof Response) return note;
  const source = (body.source ?? "web") as Source;
  if (!SOURCES.includes(source)) return json({ error: `source must be one of ${SOURCES.join(", ")}.` }, 400);

  const storefront = env.STOREFRONT || "ch";
  const now = deps.now().toISOString();
  try {
    const link = parseAppleMusicLink(body.url);
    const albumId = await albumIdFor(link, storefront, deps.fetch);

    // Known album: no need to ask Apple again.
    const existing = await findByAppleId(env.DB, albumId);
    const result =
      existing?.status === "listed"
        ? { outcome: "duplicate" as const, album: existing, summary: `Already on the list: ${describe(existing)}` }
        : existing
          ? await restoreAlbum(env.DB, existing, { note, source, now })
          : await addAlbum(env.DB, await fetchAlbum(albumId, storefront, deps.fetch), { note, source, now });

    return json(
      { outcome: result.outcome, summary: result.summary, album: publicAlbum(result.album) },
      result.outcome === "created" ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof LinkError || error instanceof LookupError) {
      return json({ error: error.message, summary: error.message }, error.status);
    }
    throw error;
  }
}

async function admin(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const who = await deps.verify(request, env);
  if (!who) return json({ error: "Not signed in." }, 401);

  const { pathname } = url;
  const method = request.method;
  if (pathname === "/admin" || pathname === "/admin/") {
    if (method === "GET" || method === "HEAD") return html(adminPage(who), 200, { "cache-control": "no-store" });
    return json({ error: "Method not allowed." }, 405);
  }
  if (pathname === "/admin/albums") {
    if (method === "POST") return addFromLink(request, env, deps);
    return json({ error: "Method not allowed." }, 405);
  }
  return json({ error: "Not found." }, 404);
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return admin(request, env, deps, url);
  }

  if (url.pathname === "/health" && (method === "GET" || method === "HEAD")) {
    return json({ ok: true });
  }

  if (url.pathname === "/" && (method === "GET" || method === "HEAD")) {
    return html(homePage(await listedCount(env)));
  }

  // Static files under public/ (CSS, favicon) and their 404s.
  return env.ASSETS.fetch(request);
}
