import {
  addAlbum,
  describe,
  findByAppleId,
  findById,
  MIN_YEAR,
  removeAlbum,
  restoreAlbum,
  setOriginalYear,
  SOURCES,
  updateNote,
  type AddResult,
  type AlbumRow,
  type Source,
} from "./albums.ts";
import { albumIdFor, fetchAlbum, LinkError, LookupError, parseAppleMusicLink, type AppleSources } from "./apple.ts";
import type { Identity } from "./auth.ts";
import { publicAlbum, recentEvents, removedAlbums, type EventRow } from "./catalog.ts";
import { artwork, formatDate } from "./format.ts";
import { escapeHtml as e, page } from "./html.ts";
import { html, json, readBody, redirect, type Body } from "./http.ts";
import { flash } from "./pages.ts";
import type { Deps, Env } from "./app.ts";

/**
 * Owner-only routes under /admin, behind the Cloudflare Access application.
 * Each write takes JSON (Shortcut, curl, MCP) and answers JSON, or takes a
 * form posted from these pages and answers with a redirect.
 */

const MAX_NOTE_CHARS = 2000;
const MAX_REASON_CHARS = 500;

type Text = { value: string | null } | { error: string };

function readText(value: unknown, name: string, max: number): Text {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: `${name} must be text.` };
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length > max) return { error: `${name} is longer than ${max} characters.` };
  return { value: text === "" ? null : text };
}

function readSource(body: Body): Source | null {
  const source = (body.fields.source ?? "web") as Source;
  return SOURCES.includes(source) ? source : null;
}

const pageHeaders = { "cache-control": "no-store", "x-robots-tag": "noindex" };
const adminHtml = (body: string, status = 200) => html(body, status, pageHeaders);
const ROBOTS = `\n    <meta name="robots" content="noindex">`;

// ---------------------------------------------------------------------------
// Pages

function adminNav(current: "add" | "history" | null): string {
  const link = (href: string, label: string, name: string) =>
    `<a href="${href}"${current === name ? ' aria-current="page"' : ""}>${label}</a>`;
  return `      <nav class="admin-nav" aria-label="Admin">${link("/admin", "Add", "add")}${link("/admin/history", "History", "history")}</nav>\n`;
}

function thumb(a: AlbumRow): string {
  const src = artwork(a.artwork_url, 96);
  return src
    ? `<img class="thumb" src="${e(src)}" width="48" height="48" alt="" loading="lazy">`
    : `<span class="thumb cover-missing"></span>`;
}

export function adminHome(who: Identity, opts: { error?: string; url?: string; note?: string } = {}): string {
  const name = who.email ?? (who.serviceToken ? `service token ${who.serviceToken}` : "unknown");
  return page(
    "Add an album – Albums",
    `${adminNav("add")}      <h1>Add an album</h1>
${opts.error ? `      <p class="flash error" role="alert">${e(opts.error)}</p>\n` : ""}      <form class="admin-form" method="post" action="/admin/albums">
        <label>Apple Music link
          <input name="url" type="text" inputmode="url" required autocomplete="off" value="${e(opts.url ?? "")}"
            placeholder="https://music.apple.com/ch/album/…"></label>
        <label>Note <span class="hint">optional, shown on the album page</span>
          <textarea name="note" rows="3" maxlength="${MAX_NOTE_CHARS}">${e(opts.note ?? "")}</textarea></label>
        <button type="submit">Add</button>
      </form>
      <p class="hint">Signed in as ${e(name)}.</p>`,
    { head: ROBOTS, nav: "admin" },
  );
}

export const EDIT_MESSAGES: Record<string, string> = { saved: "Note saved.", year: "Original year saved." };

const editionYear = (a: AlbumRow) => (a.release_date ? a.release_date.slice(0, 4) : null);

export function editPage(a: AlbumRow, message?: string): string {
  const listed = a.status === "listed";
  const status = listed
    ? `<p class="hint"><a href="/albums/${a.id}">View on the list</a></p>`
    : `<p class="flash">Removed on ${e(formatDate(a.removed_at))}${a.removed_reason ? `: ${e(a.removed_reason)}` : ""}.</p>
      <form method="post" action="/admin/albums/${a.id}/restore"><button type="submit">Put back on the list</button></form>`;
  return page(
    `Edit ${a.title} – Albums`,
    `${adminNav(null)}${flash(message)}      <div class="admin-album">${thumb(a)}<div><h1>${e(a.title)}</h1><p class="meta">${e(a.artist)}${
      a.year ? ` · ${a.year}` : ""
    }</p></div></div>
      ${status}
      <form class="admin-form" method="post" action="/admin/albums/${a.id}">
        <label>Note <span class="hint">shown on the album page; leave empty for none</span>
          <textarea name="note" rows="4" maxlength="${MAX_NOTE_CHARS}">${e(a.note ?? "")}</textarea></label>
        <button type="submit">Save note</button>
      </form>
      <form class="admin-form" method="post" action="/admin/albums/${a.id}/year">
        <label>Original year <span class="hint">when Apple's date is a reissue's${
          editionYear(a) ? ` (Apple: ${e(editionYear(a)!)}${a.edition ? `, ${e(a.edition)}` : ""})` : ""
        }; leave empty to use Apple's</span>
          <input name="original_year" type="number" inputmode="numeric" min="${MIN_YEAR}" max="2100" value="${a.original_year ?? ""}"></label>
        <button type="submit">Save year</button>
      </form>
${
  listed
    ? `      <form class="admin-form danger" method="post" action="/admin/albums/${a.id}/remove">
        <h2>Remove from the list</h2>
        <p class="hint">It moves to the private history and can be put back.</p>
        <label>Reason <span class="hint">optional, private</span>
          <input name="reason" type="text" maxlength="${MAX_REASON_CHARS}" autocomplete="off"></label>
        <button type="submit">Remove</button>
      </form>`
    : ""
}`,
    { head: ROBOTS, nav: "admin" },
  );
}

export const HISTORY_MESSAGES: Record<string, string> = {
  removed: "Removed. It stays here and can be put back.",
};

const ACTIONS: Record<EventRow["action"], string> = { added: "Added", removed: "Removed", restored: "Put back", edited: "Note edited" };

function eventDetail(ev: EventRow): string {
  if (!ev.detail) return "";
  try {
    const d = JSON.parse(ev.detail) as { reason?: unknown; note?: unknown };
    if (typeof d.reason === "string") return d.reason;
    if ("note" in d) return typeof d.note === "string" ? d.note : "(cleared)";
    if ("original_year" in d) return typeof (d as { original_year?: unknown }).original_year === "number" ? `Original year ${String((d as { original_year: number }).original_year)}` : "Original year cleared";
  } catch {
    // ignore
  }
  return "";
}

export function historyPage(removed: AlbumRow[], events: EventRow[], message?: string): string {
  const removedList = removed.length
    ? `      <ul class="removed">
${removed
  .map(
    (a) => `        <li>${thumb(a)}<div class="what"><a href="/admin/albums/${a.id}">${e(a.title)}</a><span class="meta">${e(a.artist)}${
      a.year ? ` · ${a.year}` : ""
    }</span><span class="meta">Removed ${e(formatDate(a.removed_at))}${a.removed_reason ? `: ${e(a.removed_reason)}` : ""}</span></div>
          <form method="post" action="/admin/albums/${a.id}/restore"><button type="submit">Put back</button></form></li>`,
  )
  .join("\n")}
      </ul>`
    : `      <p class="empty">Nothing removed.</p>`;
  const log = events.length
    ? `      <table class="albums log">
        <thead><tr><th>Date</th><th>Change</th><th>Album</th><th class="wide">Via</th><th class="wide">Detail</th></tr></thead>
        <tbody>
${events
  .map(
    (ev) => `          <tr><td>${e(formatDate(ev.at))}</td><td>${ACTIONS[ev.action]}</td><td><a href="/admin/albums/${ev.album_id}">${e(ev.title)}</a> <span class="meta">${e(
      ev.artist,
    )}</span></td><td class="wide">${e(ev.source)}</td><td class="wide">${e(eventDetail(ev))}</td></tr>`,
  )
  .join("\n")}
        </tbody>
      </table>`
    : `      <p class="empty">No changes yet.</p>`;
  return page(
    "History – Albums",
    `${adminNav("history")}${flash(message)}      <h1>History</h1>
      <h2>Removed</h2>
${removedList}
      <h2>Changes</h2>
${log}`,
    { head: ROBOTS, nav: "admin" },
  );
}

// ---------------------------------------------------------------------------
// Actions

/** Adds from an Apple Music link, reports a duplicate, or restores a removed album. */
export async function addFromLink(env: Env, deps: Deps, link: string, note: string | null, source: Source): Promise<AddResult> {
  const storefront = env.STOREFRONT || "ch";
  const now = deps.now().toISOString();
  const apple: AppleSources = { fetch: deps.fetch, musicToken: () => deps.musicToken(env) };
  const albumId = await albumIdFor(parseAppleMusicLink(link), storefront, apple);
  // Known album: no need to ask Apple again.
  const existing = await findByAppleId(env.DB, albumId);
  if (existing?.status === "listed") {
    return { outcome: "duplicate", album: existing, summary: `Already on the list: ${describe(existing)}` };
  }
  if (existing) return restoreAlbum(env.DB, existing, { note, source, now });
  return addAlbum(env.DB, await fetchAlbum(albumId, storefront, apple), { note, source, now });
}

async function add(request: Request, env: Env, deps: Deps, url: URL, who: Identity): Promise<Response> {
  const body = await readBody(request, url);
  if (body instanceof Response) return body;
  const link = body.fields.url;
  const note = readText(body.fields.note, "note", MAX_NOTE_CHARS);
  const source = readSource(body);
  const problem =
    typeof link !== "string" || link.trim() === ""
      ? "url is required."
      : "error" in note
        ? note.error
        : source === null
          ? `source must be one of ${SOURCES.join(", ")}.`
          : null;
  const formValues = { url: typeof link === "string" ? link : "", note: typeof body.fields.note === "string" ? body.fields.note : "" };
  if (problem) {
    return body.kind === "json" ? json({ error: problem }, 400) : adminHtml(adminHome(who, { error: problem, ...formValues }), 400);
  }
  try {
    const result = await addFromLink(env, deps, link as string, (note as { value: string | null }).value, source!);
    if (body.kind === "form") return redirect(`/albums/${result.album.id}?msg=${result.outcome}`);
    return json(
      { outcome: result.outcome, summary: result.summary, album: publicAlbum(result.album) },
      result.outcome === "created" ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof LinkError || error instanceof LookupError) {
      return body.kind === "json"
        ? json({ error: error.message, summary: error.message }, error.status)
        : adminHtml(adminHome(who, { error: error.message, ...formValues }), error.status);
    }
    throw error;
  }
}

type AlbumAction = "save" | "year" | "remove" | "restore";

/** "" or missing clears; otherwise a whole year from MIN_YEAR to next year. */
export function readYear(value: unknown, now: Date): { value: number | null } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: null };
  const year = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{4}\s*$/.test(value) ? Number(value) : NaN;
  const max = now.getUTCFullYear() + 1;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > max) return { error: `original_year must be a year from ${MIN_YEAR} to ${max}.` };
  return { value: year };
}

async function change(request: Request, env: Env, deps: Deps, url: URL, album: AlbumRow, action: AlbumAction): Promise<Response> {
  const body = await readBody(request, url);
  if (body instanceof Response) return body;
  const source = readSource(body);
  if (source === null) return json({ error: `source must be one of ${SOURCES.join(", ")}.` }, 400);
  const opts = { source, now: deps.now().toISOString() };
  const fail = (message: string, status: number) => (body.kind === "json" ? json({ error: message }, status) : adminHtml(editPage(album, message), status));

  if (action === "save") {
    const note = readText(body.fields.note, "note", MAX_NOTE_CHARS);
    if ("error" in note) return fail(note.error, 400);
    const updated = await updateNote(env.DB, album, note.value, opts);
    if (body.kind === "json") return json({ outcome: "saved", summary: `Note saved: ${describe(updated)}`, album: publicAlbum(updated) });
    return redirect(updated.status === "listed" ? `/albums/${updated.id}?msg=saved` : `/admin/albums/${updated.id}?msg=saved`);
  }

  if (action === "year") {
    const year = readYear(body.fields.original_year, deps.now());
    if ("error" in year) return fail(year.error, 400);
    const updated = await setOriginalYear(env.DB, album, year.value, opts);
    if (body.kind === "json") return json({ outcome: "saved", summary: `Year saved: ${describe(updated)}`, album: publicAlbum(updated) });
    return redirect(`/admin/albums/${updated.id}?msg=year`);
  }

  if (action === "remove") {
    if (album.status === "removed") return fail("Already removed.", 409);
    const reason = readText(body.fields.reason, "reason", MAX_REASON_CHARS);
    if ("error" in reason) return fail(reason.error, 400);
    const removed = await removeAlbum(env.DB, album, reason.value, opts);
    if (body.kind === "json") return json({ outcome: "removed", summary: `Removed: ${describe(removed)}`, id: removed.id });
    return redirect("/admin/history?msg=removed");
  }

  if (album.status === "listed") return fail("Already on the list.", 409);
  const result = await restoreAlbum(env.DB, album, { note: null, ...opts });
  if (body.kind === "json") return json({ outcome: result.outcome, summary: result.summary, album: publicAlbum(result.album) });
  return redirect(`/albums/${result.album.id}?msg=restored`);
}

export async function admin(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  const who = await deps.verify(request, env);
  if (!who) return json({ error: "Not signed in." }, 401);

  const path = url.pathname.replace(/\/+$/, "");
  const get = request.method === "GET" || request.method === "HEAD";
  const post = request.method === "POST";
  const msg = url.searchParams.get("msg") ?? "";
  const notAllowed = () => json({ error: "Method not allowed." }, 405);

  if (path === "/admin") return get ? adminHtml(adminHome(who)) : notAllowed();
  if (path === "/admin/history") {
    if (!get) return notAllowed();
    const [removed, events] = await Promise.all([removedAlbums(env.DB), recentEvents(env.DB)]);
    return adminHtml(historyPage(removed, events, HISTORY_MESSAGES[msg]));
  }
  if (path === "/admin/albums") return post ? add(request, env, deps, url, who) : notAllowed();

  const m = path.match(/^\/admin\/albums\/([1-9]\d{0,9})(?:\/(remove|restore|year))?$/);
  if (m) {
    const album = await findById(env.DB, Number(m[1]));
    if (!album) return json({ error: "Not found." }, 404);
    const sub = m[2] as "remove" | "restore" | "year" | undefined;
    if (!sub && get) return adminHtml(editPage(album, EDIT_MESSAGES[msg]));
    if (!post) return notAllowed();
    return change(request, env, deps, url, album, sub ?? "save");
  }
  return json({ error: "Not found." }, 404);
}
