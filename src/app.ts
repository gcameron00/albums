import { addAlbum, describe, findByAppleId, restoreAlbum, SOURCES, type Source } from "./albums.ts";
import { albumIdFor, fetchAlbum, LinkError, LookupError, parseAppleMusicLink, type AppleSources } from "./apple.ts";
import type { AuthEnv, Identity } from "./auth.ts";
import type { MusicKeyEnv } from "./musicToken.ts";
import { facets, getAlbum, listAlbums, moreByArtist, pageSize, parseListQuery, publicAlbum, queryParams, randomAlbum } from "./catalog.ts";
import { escapeHtml, page } from "./html.ts";
import { aboutPage, albumPage, listPage, notFoundPage } from "./pages.ts";

export interface Env extends AuthEnv, MusicKeyEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  STOREFRONT: string;
}

/** What the handler needs from outside, so tests can replace it. */
export interface Deps {
  verify(request: Request, env: Env): Promise<Identity | null>;
  fetch: typeof fetch;
  musicToken(env: Env): Promise<string | null>;
  now(): Date;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const MAX_BODY_BYTES = 8192;
const MAX_NOTE_CHARS = 2000;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra },
  });
}

/** Public, read-only JSON: any site may read it. */
const publicJson = (body: unknown, status = 200) =>
  json(body, status, { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" });

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
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
  const apple: AppleSources = { fetch: deps.fetch, musicToken: () => deps.musicToken(env) };
  try {
    const link = parseAppleMusicLink(body.url);
    const albumId = await albumIdFor(link, storefront, apple);

    // Known album: no need to ask Apple again.
    const existing = await findByAppleId(env.DB, albumId);
    const result =
      existing?.status === "listed"
        ? { outcome: "duplicate" as const, album: existing, summary: `Already on the list: ${describe(existing)}` }
        : existing
          ? await restoreAlbum(env.DB, existing, { note, source, now })
          : await addAlbum(env.DB, await fetchAlbum(albumId, storefront, apple), { note, source, now });

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

/** Positive integer id from a path segment, or null. */
function idParam(segment: string | undefined): number | null {
  return segment && /^[1-9]\d{0,9}$/.test(segment) ? Number(segment) : null;
}

/** Public pages and the read-only API. Null when the path is not one of them. */
async function publicRoute(env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const storefront = env.STOREFRONT || "ch";

  if (path === "/health") return json({ ok: true });

  if (path === "/") {
    const q = parseListQuery(url.searchParams);
    const [f, result] = await Promise.all([facets(env.DB), listAlbums(env.DB, q)]);
    return html(listPage(q, f, result, storefront));
  }

  if (path === "/about") return html(aboutPage());

  if (path === "/random") {
    const q = parseListQuery(url.searchParams);
    const album = await randomAlbum(env.DB, q);
    const target = album ? `/albums/${album.id}` : `/?${queryParams(q)}`;
    return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store", ...SECURITY_HEADERS } });
  }

  const albumMatch = path.match(/^\/albums\/([^/]+)\/?$/);
  if (albumMatch) {
    const id = idParam(albumMatch[1]);
    const album = id === null ? null : await getAlbum(env.DB, id);
    if (!album) return html(notFoundPage(), 404);
    const more = await moreByArtist(env.DB, album);
    return html(albumPage(album, more, storefront));
  }

  if (path === "/api/albums") {
    const q = parseListQuery(url.searchParams);
    const result = await listAlbums(env.DB, q);
    return publicJson({
      total: result.total,
      page: q.page,
      page_size: pageSize(q.view),
      albums: result.albums.map(publicAlbum),
    });
  }

  const apiMatch = path.match(/^\/api\/albums\/([^/]+)$/);
  if (apiMatch) {
    const id = idParam(apiMatch[1]);
    const album = id === null ? null : await getAlbum(env.DB, id);
    if (!album) return publicJson({ error: "Not found." }, 404);
    return publicJson(publicAlbum(album));
  }

  return null;
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return admin(request, env, deps, url);
  }

  if (method === "GET" || method === "HEAD") {
    const response = await publicRoute(env, url);
    if (response) return response;
  }

  // Static files under public/ (CSS, JS, favicon); anything else is a 404 page.
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404 && !url.pathname.startsWith("/assets/")) return html(notFoundPage(), 404);
  return asset;
}
