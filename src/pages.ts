import type { AlbumRow } from "./albums.ts";
import { DEFAULT_DIR, pageSize, queryParams, SORTS, type Dir, type Facets, type ListQuery, type Sort, type View } from "./catalog.ts";
import { artwork, formatAlbumTime, formatDate, plural } from "./format.ts";
import { escapeHtml as e, page } from "./html.ts";

const albumHref = (a: AlbumRow) => `/albums/${a.id}`;
const listHref = (q: ListQuery, change: Partial<ListQuery> = {}) => {
  const p = queryParams(q, change).toString();
  return p ? `/?${p}` : "/";
};
/** /random with the current search and filters (not sort, view or page). */
const randomHref = (q: ListQuery) => {
  const p = queryParams(q, { sort: "added", view: "grid" }).toString();
  return p ? `/random?${p}` : "/random";
};
const embedUrl = (a: AlbumRow, storefront: string) =>
  `https://embed.music.apple.com/${storefront}/album/${encodeURIComponent(a.apple_id)}`;

/** Apple Music player iframe; the browser loads it only when it nears the screen. */
const player = (a: AlbumRow, storefront: string) =>
  `<iframe src="${e(embedUrl(a, storefront))}" title="${e(`${a.title} on Apple Music`)}" height="450" loading="lazy"
          allow="autoplay *; encrypted-media *; clipboard-write"
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"></iframe>`;

const artistHref = (artist: string) => `/?${new URLSearchParams({ artist, sort: "year" })}`;

function cover(a: AlbumRow, size: number, cls: string, lazy = true): string {
  const src = artwork(a.artwork_url, size);
  const alt = `${a.title} by ${a.artist}`;
  if (!src) return `<div class="${cls} cover-missing" role="img" aria-label="${e(alt)}"></div>`;
  const src2x = artwork(a.artwork_url, size * 2)!;
  return `<img class="${cls}" src="${e(src)}" srcset="${e(src)} 1x, ${e(src2x)} 2x" width="${size}" height="${size}" alt="${e(alt)}"${
    lazy ? ' loading="lazy" decoding="async"' : ""
  }>`;
}

const yearOf = (a: AlbumRow) => (a.year ? String(a.year) : "");

// ---------------------------------------------------------------------------
// List: grid or table, with filters

function filters(q: ListQuery, f: Facets): string {
  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${e(value)}"${selected ? " selected" : ""}>${e(label)}</option>`;
  return `      <form class="filters" method="get" action="/" role="search">
        <label class="search"><span class="visually-hidden">Search</span>
          <input type="search" name="q" value="${e(q.q)}" placeholder="Artist or album" autocomplete="off"></label>
        <label><span class="visually-hidden">Sort</span>
          <select name="sort">${(Object.entries(SORTS) as Array<[Sort, string]>)
            .map(([value, label]) => option(value, label, q.sort === value))
            .join("")}</select></label>
        <label><span class="visually-hidden">Decade</span>
          <select name="decade">${option("", "Any decade", q.decade === null)}${f.decades
            .map((d) => option(String(d.decade), `${d.decade}s (${d.n})`, q.decade === d.decade))
            .join("")}</select></label>
        <label><span class="visually-hidden">Genre</span>
          <select name="genre">${option("", "Any genre", !q.genre)}${f.genres
            .map((g) => option(g.genre, `${g.genre} (${g.n})`, q.genre === g.genre))
            .join("")}</select></label>${q.artist ? `\n        <input type="hidden" name="artist" value="${e(q.artist)}">` : ""}${
          q.view !== "grid" ? `\n        <input type="hidden" name="view" value="${e(q.view)}">` : ""
        }
        <button type="submit">Show</button>
      </form>`;
}

function grid(albums: AlbumRow[]): string {
  return `      <ul class="grid">
${albums
  .map(
    (a) => `        <li><a href="${albumHref(a)}">${cover(a, 300, "cover")}
          <span class="title">${e(a.title)}</span>
          <span class="meta">${e(a.artist)}${a.year ? ` · ${a.year}` : ""}</span></a></li>`,
  )
  .join("\n")}
      </ul>`;
}

/** Column heading that sorts by it; a second click reverses the order. */
function sortHeading(q: ListQuery, sort: Sort, label: string, cls = ""): string {
  const active = q.sort === sort;
  const dir: Dir = active ? (q.dir === "asc" ? "desc" : "asc") : DEFAULT_DIR[sort];
  const aria = active ? ` aria-sort="${q.dir === "asc" ? "ascending" : "descending"}"` : "";
  const arrow = active ? `<span class="arrow" aria-hidden="true">${q.dir === "asc" ? "▲" : "▼"}</span>` : "";
  return `<th${cls ? ` class="${cls}"` : ""}${aria}><a href="${e(listHref(q, { sort, dir, page: 1 }))}">${label}${arrow}</a></th>`;
}

function table(albums: AlbumRow[], q: ListQuery): string {
  return `      <table class="albums">
        <thead><tr>${sortHeading(q, "artist", "Artist")}${sortHeading(q, "title", "Album")}${sortHeading(
          q,
          "year",
          "Year",
        )}<th class="wide">Genre</th><th class="wide">Length</th>${sortHeading(q, "added", "Added", "wide")}</tr></thead>
        <tbody>
${albums
  .map(
    (a) => `          <tr><td><a href="${e(artistHref(a.artist))}">${e(a.artist)}</a></td><td><a href="${albumHref(a)}">${e(a.title)}</a></td><td>${e(
      yearOf(a),
    )}</td><td class="wide">${e(a.genre ?? "")}</td><td class="wide">${e(formatAlbumTime(a.duration_ms))}</td><td class="wide">${e(
      formatDate(a.added_at),
    )}</td></tr>`,
  )
  .join("\n")}
        </tbody>
      </table>`;
}

function players(albums: AlbumRow[], storefront: string): string {
  return `      <ul class="players">
${albums
  .map(
    (a) => `        <li>
          <a class="player-head" href="${albumHref(a)}">${cover(a, 64, "thumb")}<span><span class="title">${e(a.title)}</span>
          <span class="meta">${e(a.artist)}${a.year ? ` · ${a.year}` : ""}</span></span></a>
          ${player(a, storefront)}
        </li>`,
  )
  .join("\n")}
      </ul>`;
}

function pager(q: ListQuery, total: number): string {
  const pages = Math.ceil(total / pageSize(q.view));
  if (pages <= 1) return "";
  const prev = q.page > 1 ? `<a rel="prev" href="${e(listHref(q, { page: q.page - 1 }))}">← Previous</a>` : "<span></span>";
  const next = q.page < pages ? `<a rel="next" href="${e(listHref(q, { page: q.page + 1 }))}">Next →</a>` : "<span></span>";
  return `      <nav class="pager" aria-label="Pages">${prev}<span>Page ${q.page} of ${pages}</span>${next}</nav>`;
}

export function listPage(q: ListQuery, f: Facets, result: { total: number; albums: AlbumRow[] }, storefront: string): string {
  const filtered = Boolean(q.q || q.decade || q.genre || q.artist);
  const heading = q.artist || "Albums";
  const summary = filtered
    ? `${plural(result.total, "album")} of ${f.total}${q.artist ? "" : " match"}`
    : `${plural(f.total, "album")} worth playing from start to finish`;
  const viewLink = (view: View, label: string) =>
    `<a href="${e(listHref(q, { view }))}"${q.view === view ? ' aria-current="true"' : ""}>${label}</a>`;
  const views = `<a class="random" href="${e(randomHref(q))}">Play something</a><span class="views">${viewLink("grid", "Covers")} ${viewLink(
    "list",
    "List",
  )} ${viewLink("play", "Players")}</span>`;

  let content: string;
  if (f.total === 0) content = `      <p class="empty">Nothing on the list yet.</p>`;
  else if (result.albums.length === 0)
    content = `      <p class="empty">No albums match. <a href="${e(listHref({ ...q, q: "", decade: null, genre: "", artist: "" }))}">Show all</a></p>`;
  else content = q.view === "list" ? table(result.albums, q) : q.view === "play" ? players(result.albums, storefront) : grid(result.albums);

  return page(
    q.artist ? `${q.artist} – Albums` : "Albums",
    `      <div class="list-head">
        <h1>${e(heading)}</h1>
        <p class="summary">${e(summary)}${filtered ? ` · <a href="/">Clear</a>` : ""}</p>
      </div>
${f.total > 0 ? `${filters(q, f)}\n      <div class="toolbar">${views}</div>\n` : ""}${content}
${pager(q, result.total)}`,
    { nav: "albums", script: "/assets/js/filters.js" },
  );
}

// ---------------------------------------------------------------------------
// One album

function noteHtml(note: string): string {
  return note
    .split(/\n{2,}/)
    .map((p) => `<p>${e(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Confirmations shown on an album page after an owner action (?msg=). */
export const ALBUM_MESSAGES: Record<string, string> = {
  created: "Added to the list.",
  duplicate: "Already on the list.",
  restored: "Back on the list.",
  saved: "Note saved.",
};

export function flash(message: string | undefined): string {
  return message ? `      <p class="flash" role="status">${e(message)}</p>
` : "";
}

export function albumPage(
  a: AlbumRow,
  more: AlbumRow[],
  storefront: string,
  opts: { signedIn?: boolean; message?: string } = {},
): string {
  const facts = [
    a.year ? String(a.year) : "",
    a.genre ?? "",
    a.track_count ? plural(a.track_count, "track") : "",
    formatAlbumTime(a.duration_ms),
  ].filter(Boolean);
  const og = artwork(a.artwork_url, 600);
  return page(
    `${a.title} – ${a.artist}`,
    `${flash(opts.message)}      <article class="album">
        <div class="album-cover">${cover(a, 600, "cover", false)}</div>
        <div class="album-info">
          <h1>${e(a.title)}</h1>
          <p class="artist"><a href="${e(artistHref(a.artist))}">${e(a.artist)}</a></p>
          <p class="facts">${facts.map(e).join(" · ")}</p>
${a.note ? `          <div class="note">${noteHtml(a.note)}</div>\n` : ""}          <p class="links"><a class="button" href="${e(a.apple_url)}" rel="noopener">Open in Apple Music</a></p>
          <p class="added">On the list since ${e(formatDate(a.added_at))}${
            opts.signedIn ? ` · <a href="/admin/albums/${a.id}">Edit</a>` : ""
          }</p>
        </div>
      </article>
      <section class="player" aria-label="Player">
        ${player(a, storefront)}
      </section>
${
      more.length
        ? `      <section aria-labelledby="more"><h2 id="more">More by ${e(a.artist)}</h2>\n${grid(more)}\n      </section>\n`
        : ""
    }`,
    {
      nav: "albums",
      description: `${a.title} by ${a.artist}${a.year ? ` (${a.year})` : ""}: worth playing from start to finish.`,
      head: og
        ? `\n    <meta property="og:title" content="${e(`${a.title} – ${a.artist}`)}">\n    <meta property="og:image" content="${e(og)}">`
        : "",
    },
  );
}

// ---------------------------------------------------------------------------

export function aboutPage(): string {
  return page(
    "About – Albums",
    `      <article class="prose">
        <h1>About</h1>
        <p>A personal list of albums worth playing from start to finish: records where the whole thing holds up, not just a great track or two.</p>
        <p>Mostly original studio albums. Live albums and compilations stay off the list, with the odd exception.</p>
        <p>There is no ranking. Everything here is a favourite of some kind.</p>
        <p>Albums play through Apple Music. The players on album pages need an Apple Music subscription for full tracks; without one they play previews.</p>
        <p>The list is also available as JSON at <a href="/api/albums">/api/albums</a>.</p>
      </article>`,
    { nav: "about", description: "What this list of albums is, and how albums get on it." },
  );
}

export function notFoundPage(): string {
  return page(
    "Not found – Albums",
    `      <article class="prose">
        <h1>Not found</h1>
        <p>That page is not here. It may have been removed from the list.</p>
        <p><a href="/">Back to the list</a></p>
      </article>`,
  );
}
