import { admin } from "./admin.ts";
import type { AuthEnv, Identity } from "./auth.ts";
import { facets, getAlbum, listAlbums, moreByArtist, pageSize, parseListQuery, publicAlbum, queryParams, randomAlbum } from "./catalog.ts";
import { html, json, SECURITY_HEADERS } from "./http.ts";
import { mcp } from "./mcp.ts";
import type { MusicKeyEnv } from "./musicToken.ts";
import { aboutPage, ALBUM_MESSAGES, albumPage, listPage, notFoundPage } from "./pages.ts";

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

/** Public, read-only JSON: any site may read it. */
const publicJson = (body: unknown, status = 200) =>
  json(body, status, { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" });

/**
 * Whether the browser holds a Cloudflare Access session cookie. Only used to
 * show an Edit link; /admin itself is protected by Access and the JWT check.
 */
const hasAccessCookie = (request: Request) => /(?:^|;\s*)CF_Authorization=/.test(request.headers.get("cookie") ?? "");

/** Positive integer id from a path segment, or null. */
function idParam(segment: string | undefined): number | null {
  return segment && /^[1-9]\d{0,9}$/.test(segment) ? Number(segment) : null;
}

/** Public pages and the read-only API. Null when the path is not one of them. */
async function publicRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
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
    const message = ALBUM_MESSAGES[url.searchParams.get("msg") ?? ""];
    const signedIn = hasAccessCookie(request);
    return html(albumPage(album, more, storefront, { signedIn, message }), 200, signedIn || message ? { "cache-control": "no-store" } : {});
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

  // MCP for Claude. Cloudflare Access (Managed OAuth) checks the client's
  // token at the edge and forwards its usual JWT; it must name a person.
  if (url.pathname === "/mcp") {
    const who = await deps.verify(request, env);
    if (!who) return json({ error: "Not signed in." }, 401);
    if (!who.email) return json({ error: "MCP needs a person signed in, not a service token." }, 403);
    return mcp(request, env, deps, { email: who.email });
  }

  if (method === "GET" || method === "HEAD") {
    const response = await publicRoute(request, env, url);
    if (response) return response;
  }

  // Static files under public/ (CSS, JS, favicon); anything else is a 404 page.
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404 && !url.pathname.startsWith("/assets/")) return html(notFoundPage(), 404);
  return asset;
}
