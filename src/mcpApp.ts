/**
 * MCP App: the cover view that MCP clients supporting the MCP Apps extension
 * (io.modelcontextprotocol/ui, spec 2026-01-26) show beside the results of
 * search_albums, random_album and get_album.
 *
 * The server offers it as a ui:// resource; those tools point at it in their
 * _meta. The host loads the HTML in a sandboxed frame and passes it the tool
 * result over postMessage (JSON-RPC). Clients without MCP Apps ignore all of
 * this and read the tool's text and structuredContent as before.
 *
 * The page is one self-contained file: no external scripts or styles. Covers
 * load from Apple's image CDN, which the CSP below allows. Album data is put
 * into the page with DOM APIs (textContent, setAttribute), never as HTML.
 *
 * The page lives in a template literal: keep backticks out of it, and use
 * dollar-brace only to interpolate on purpose (the protocol version).
 */

export const APP_URI = "ui://albums/covers.html";
export const APP_MIME = "text/html;profile=mcp-app";
export const APP_PROTOCOL = "2026-01-26";

/** Hosts Apple serves artwork from (src/apple.ts keeps Apple's URLs as given). */
export const ARTWORK_DOMAINS = [1, 2, 3, 4, 5].map((n) => `https://is${n}-ssl.mzstatic.com`);

/** _meta.ui on the resource: what the frame may load, and how it is framed. */
export const APP_RESOURCE_META = {
  ui: {
    csp: { resourceDomains: ARTWORK_DOMAINS, connectDomains: [] as string[] },
    prefersBorder: false,
  },
};

/** _meta on a tool that renders with the cover view (current and legacy key). */
export const APP_TOOL_META = {
  ui: { resourceUri: APP_URI, visibility: ["model", "app"] },
  "ui/resourceUri": APP_URI,
};

export const APP_RESOURCE = {
  uri: APP_URI,
  name: "album-covers",
  title: "Album covers",
  description: "Shows albums from search_albums, random_album and get_album as covers, with links to Apple Music.",
  mimeType: APP_MIME,
  _meta: APP_RESOURCE_META,
};

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Albums</title>
<style>
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, transparent);
  --surface: var(--color-background-secondary, #f4f2ee);
  --text: var(--color-text-primary, #1c1b1a);
  --muted: var(--color-text-secondary, #6b6760);
  --border: var(--color-border-primary, #e6e2dc);
  --accent: #b4321e;
  --on-accent: #ffffff;
  --radius: var(--border-radius-md, 8px);
  --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
}
:root[data-theme="dark"] {
  --surface: var(--color-background-secondary, #1d1c1a);
  --text: var(--color-text-primary, #ece9e4);
  --muted: var(--color-text-secondary, #a19c94);
  --border: var(--color-border-primary, #2f2d2a);
  --accent: #f07a62;
  --on-accent: #1c1b1a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface: var(--color-background-secondary, #1d1c1a);
    --text: var(--color-text-primary, #ece9e4);
    --muted: var(--color-text-secondary, #a19c94);
    --border: var(--color-border-primary, #2f2d2a);
    --accent: #f07a62;
    --on-accent: #1c1b1a;
  }
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 var(--font); }
body { padding: 4px 0 8px; }
button { font: inherit; color: inherit; }
.status { color: var(--muted); margin: 4px 0 10px; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 14px 12px; align-items: start; }
.tile { display: block; width: 100%; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; border-radius: var(--radius); }
.tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.tile[aria-expanded="true"] .cover { outline: 2px solid var(--accent); outline-offset: 2px; }
.cover { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: var(--radius); background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08), 0 3px 10px rgb(0 0 0 / 0.08); }
.cover.missing { border: 1px solid var(--border); box-shadow: none; }
.tile .title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 6px; font-weight: 600; font-size: 13px; }
.tile .sub { display: block; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card { display: flex; gap: 16px; align-items: flex-start; padding: 14px; background: var(--surface); border-radius: calc(var(--radius) + 4px); }
.grid .card { grid-column: 1 / -1; }
.card .cover { width: 148px; flex: none; }
.card .body { min-width: 0; flex: 1; }
.card h2 { margin: 0; font-size: 17px; line-height: 1.25; }
.card .artist { margin: 2px 0 0; font-size: 15px; }
.card .meta { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.card .note { margin: 8px 0 0; font-style: italic; }
.card .badge { display: inline-block; margin-top: 6px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.actions button { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; }
.actions button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.actions button:disabled { opacity: 0.6; cursor: default; }
.more { margin-top: 14px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--border); background: none; cursor: pointer; }
@media (max-width: 420px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 12px 10px; }
  .card { flex-direction: column; }
  .card .cover { width: 100%; max-width: 240px; }
}
</style>
</head>
<body>
<div id="root"><p class="status">Loading albums…</p></div>
<script>
(function () {
  "use strict";
  var FIRST = 24;
  var root = document.getElementById("root");
  var nextId = 1;
  var pending = {};

  // ---- JSON-RPC over postMessage with the host --------------------------
  function post(msg) { window.parent.postMessage(msg, "*"); }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error("timeout")); }
      }, 15000);
    });
  }
  function reply(id, result) { post({ jsonrpc: "2.0", id: id, result: result }); }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "error")); else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case "ui/notifications/tool-result": render(m.params); break;
      case "ui/notifications/tool-cancelled": showStatus("Cancelled."); break;
      case "ui/notifications/host-context-changed": applyContext(m.params); break;
      case "ui/resource-teardown": case "ping": if (m.id !== undefined) reply(m.id, {}); break;
      default:
        if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  function applyContext(ctx) {
    if (!ctx) return;
    var html = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") html.setAttribute("data-theme", ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (k.indexOf("--") === 0 && typeof vars[k] === "string") html.style.setProperty(k, vars[k]);
      });
    }
    var inset = ctx.safeAreaInsets;
    if (inset) {
      document.body.style.paddingLeft = (inset.left || 0) + "px";
      document.body.style.paddingRight = (inset.right || 0) + "px";
    }
  }

  function openLink(url) {
    request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
  }

  // ---- Size reporting ---------------------------------------------------
  var lastHeight = 0;
  function reportSize() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === lastHeight) return;
    lastHeight = h;
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.scrollWidth), height: h });
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.documentElement);

  // ---- Rendering --------------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function showStatus(text) {
    root.textContent = "";
    root.appendChild(el("p", "status", text));
  }
  /** Apple's artwork URL at another square size. */
  function sized(url, size) {
    return url ? String(url).replace(/\\/\\d+x\\d+bb\\.jpg$/, "/" + size + "x" + size + "bb.jpg") : null;
  }
  function coverImg(a, size) {
    if (!a.cover) {
      var d = el("div", "cover missing");
      d.setAttribute("role", "img");
      d.setAttribute("aria-label", "No cover: " + a.title);
      return d;
    }
    var img = el("img", "cover");
    img.src = sized(a.cover, size);
    img.setAttribute("srcset", sized(a.cover, size) + " 1x, " + sized(a.cover, size * 2) + " 2x");
    img.alt = "Cover of " + a.title + " by " + a.artist;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("load", reportSize);
    return img;
  }
  function metaLine(a) {
    var parts = [];
    if (a.year) parts.push(a.original_year && a.edition_release_date ? a.year + " (this edition " + a.edition_release_date.slice(0, 4) + ")" : a.year);
    if (a.genre) parts.push(a.genre);
    if (a.tracks) parts.push(a.tracks + (a.tracks === 1 ? " track" : " tracks"));
    if (a.length) parts.push(a.length);
    return parts.join(" · ");
  }
  function card(a, tag) {
    var c = el(tag || "div", "card");
    c.appendChild(coverImg(a, 300));
    var b = el("div", "body");
    b.appendChild(el("h2", null, a.title));
    b.appendChild(el("p", "artist", a.artist));
    var meta = metaLine(a);
    if (meta) b.appendChild(el("p", "meta", meta));
    if (a.status === "removed") b.appendChild(el("span", "badge", "Removed" + (a.removed_at ? " " + String(a.removed_at).slice(0, 10) : "")));
    if (a.note) b.appendChild(el("p", "note", a.note));
    var actions = el("div", "actions");
    var play = el("button", "primary", "Play");
    play.type = "button";
    play.title = "Ask Claude to play it on Sonos";
    play.addEventListener("click", function () {
      play.disabled = true;
      request("ui/message", {
        role: "user",
        content: [{ type: "text", text: "Play the album \\u201c" + a.title + "\\u201d by " + a.artist + " on Sonos." }]
      }).then(function () { play.textContent = "Asked Claude"; }, function () { play.disabled = false; play.textContent = "Couldn\\u2019t ask Claude"; });
    });
    actions.appendChild(play);
    if (a.apple_url) actions.appendChild(linkButton("Apple Music", a.apple_url));
    if (a.page) actions.appendChild(linkButton("Album page", a.page));
    b.appendChild(actions);
    c.appendChild(b);
    return c;
  }
  function linkButton(label, url) {
    var btn = el("button", null, label);
    btn.type = "button";
    btn.addEventListener("click", function () { openLink(url); });
    return btn;
  }

  /** Albums from a tool result: {albums}, {album} or one album. */
  function albumsFrom(result) {
    var data = result && result.structuredContent;
    if (!data && result && Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i++) {
        var item = result.content[i];
        if (item && item.type === "text") { try { data = JSON.parse(item.text); } catch (e) { /* not JSON */ } break; }
      }
    }
    if (!data || typeof data !== "object") return null;
    if (Array.isArray(data.albums)) return { albums: data.albums, total: typeof data.total === "number" ? data.total : data.albums.length };
    if (data.album && data.album.title) return { albums: [data.album], total: 1 };
    if (data.title && data.artist) return { albums: [data], total: 1 };
    return null;
  }

  function render(result) {
    if (result && result.isError) {
      var text = result.content && result.content[0] && result.content[0].text;
      return showStatus(text || "Something went wrong.");
    }
    var found = albumsFrom(result);
    if (!found) return showStatus("Nothing to show.");
    var albums = found.albums;
    root.textContent = "";
    if (albums.length === 0) return showStatus("No albums matched.");
    if (albums.length === 1) { root.appendChild(card(albums[0])); return; }

    var shown = Math.min(albums.length, FIRST);
    var status = el("p", "status");
    root.appendChild(status);
    var grid = el("div", "grid");
    root.appendChild(grid);
    var open = null;

    function setStatus() {
      var more = found.total > shown ? " of " + found.total : "";
      status.textContent = shown + more + (found.total === 1 ? " album" : " albums");
    }
    function closeCard() {
      if (!open) return;
      open.panel.remove();
      open.tile.setAttribute("aria-expanded", "false");
      open = null;
    }
    function toggle(tile, a) {
      var same = open && open.tile === tile;
      closeCard();
      if (same) return;
      // Insert after the last tile in the clicked tile's row.
      var after = tile;
      var top = tile.offsetTop;
      var next = tile.nextElementSibling;
      while (next && next.classList.contains("tile") && next.offsetTop === top) { after = next; next = next.nextElementSibling; }
      var panel = card(a, "section");
      after.after(panel);
      tile.setAttribute("aria-expanded", "true");
      open = { tile: tile, panel: panel };
    }
    function addTiles(from, to) {
      for (var i = from; i < to; i++) {
        (function (a) {
          var t = el("button", "tile");
          t.type = "button";
          t.setAttribute("aria-expanded", "false");
          t.appendChild(coverImg(a, 200));
          t.appendChild(el("span", "title", a.title));
          t.appendChild(el("span", "sub", a.artist + (a.year ? " · " + a.year : "")));
          t.addEventListener("click", function () { toggle(t, a); });
          grid.appendChild(t);
        })(albums[i]);
      }
    }
    addTiles(0, shown);
    setStatus();
    if (albums.length > shown) {
      var moreBtn = el("button", "more", "Show all " + albums.length);
      moreBtn.type = "button";
      moreBtn.addEventListener("click", function () {
        closeCard();
        addTiles(shown, albums.length);
        shown = albums.length;
        setStatus();
        moreBtn.remove();
      });
      root.appendChild(moreBtn);
    }
  }

  // ---- Handshake --------------------------------------------------------
  request("ui/initialize", {
    appInfo: { name: "albums-covers", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "${APP_PROTOCOL}"
  }).then(function (res) {
    applyContext(res && res.hostContext);
    notify("ui/notifications/initialized", {});
    reportSize();
  }, function () { reportSize(); });
})();
</script>
</body>
</html>
`;
