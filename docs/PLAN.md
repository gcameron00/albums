# Plan

Draft, 2026-11-08. Assumptions are marked **(assumed)** and are open
questions until confirmed (section 10).

## 1. Goals

- One canonical list of "play it start to finish" albums, easy to add to from
  the phone in a couple of taps.
- Pleasant to browse for anyone; playable in place via Apple Music embeds.
- Removals are not lost: they go to a history list and can be restored.
- Claude can read the list (and, for me, change it) over MCP.
- Same Cloudflare patterns as `groceries`: one Worker, D1, Access, separate
  preview database.

Non-goals for now: multiple users, ratings by others, streaming services other
than Apple Music, scraping Apple Music pages.

## 2. Fix the repo first (Phase 0)

What is wrong today:

| Problem | Fix |
| --- | --- |
| `wrangler.toml` says `name = "generic-website"`; the deploy workflow papers over it with `--name ${{ github.event.repository.name }}`. | `name = "albums"` (matches the deployed Worker). Done in this branch; `--name` dropped from the workflow. |
| `[assets] directory = "."` publishes the whole repo, which is why `.assetsignore` has to exclude `node_modules`, `package.json`, `wrangler.toml` etc. | Move static files to `public/` and point `[assets]` there. `.assetsignore` goes away. |
| No Worker code (`main`), so no D1, no API. | Add `src/index.ts` as `main`, with `run_worker_first` for everything except `/assets/*`. |
| No previews. The workflow only runs on `main`. | Use **Workers Builds** (Cloudflare's Git integration), as `groceries` does: production build on `main` runs `npm run deploy`; non-production branches run `npm run preview` (`wrangler preview`) with `preview_urls = true` and a `[previews]` block bound to `albums-preview`. **(assumed)** — the alternative is to keep GitHub Actions and add a `wrangler versions upload` job for branches. |
| `workers_dev = true` exposes an unprotected URL once Access is in front of the custom domain. | `workers_dev = false`; custom domain `albums.gcameron.com` declared in `routes`. |
| Placeholder `index.html` / `about/`. | Replaced by Worker-rendered pages. |
| No tests or CI. | `ci.yml`: `npm ci`, `tsc --noEmit`, `vitest run` on PRs and `main`. |

Cloudflare set-up for Phase 0:

1. Create D1 `albums` and `albums-preview` (location hint WEUR).
2. Connect the repo in Workers Builds; disable `deploy.yml` (keep as
   `workflow_dispatch` only, or delete) so deploys don't run twice.
3. Add `CLOUDFLARE_*` build variables only if Workers Builds needs them (it
   normally does not).

Shape of `wrangler.toml`:

```toml
name = "albums"
main = "src/index.ts"
compatibility_date = "2026-07-01"
workers_dev = false
preview_urls = true
routes = [{ pattern = "albums.gcameron.com", custom_domain = true }]

[assets]
directory = "public"
binding = "ASSETS"
run_worker_first = ["!/assets/*"]

[vars]
ACCESS_TEAM_DOMAIN = "grahamcameron.cloudflareaccess.com"
ACCESS_AUD = "<from the Access app>"
STOREFRONT = "ch"

[[d1_databases]]
binding = "DB"
database_name = "albums"
database_id = "<id>"
migrations_dir = "migrations"

[previews.vars]
ACCESS_TEAM_DOMAIN = "grahamcameron.cloudflareaccess.com"
ACCESS_AUD = "<preview Access app>"
STOREFRONT = "ch"

[[previews.d1_databases]]
binding = "DB"
database_name = "albums-preview"
database_id = "<id>"
```

plus `wrangler.preview-migrations.toml` (copied from `groceries`) so
`npm run preview` migrates the preview database before `wrangler preview`.

## 3. Data model (D1)

```sql
CREATE TABLE albums (
  id            INTEGER PRIMARY KEY,
  apple_id      TEXT NOT NULL UNIQUE,      -- collectionId, e.g. "1440921045"
  storefront    TEXT NOT NULL DEFAULT 'ch',
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,
  artist_id     TEXT,                      -- Apple artistId
  release_date  TEXT,                      -- ISO date
  year          INTEGER,                   -- derived, for sorting/filters
  genre         TEXT,
  track_count   INTEGER,
  duration_ms   INTEGER,                   -- sum of track lengths
  artwork_url   TEXT,                      -- template; size set at render
  apple_url     TEXT NOT NULL,             -- canonical album link
  kind          TEXT NOT NULL DEFAULT 'studio', -- studio | live | compilation | ep | soundtrack | other
  note          TEXT,                      -- why it is on the list (optional)
  status        TEXT NOT NULL DEFAULT 'listed', -- listed | removed
  added_at      TEXT NOT NULL,
  removed_at    TEXT,
  removed_reason TEXT,
  source        TEXT NOT NULL              -- web | shortcut | mcp | import
);
CREATE INDEX albums_status_artist ON albums(status, artist);
CREATE INDEX albums_status_year   ON albums(status, year);

CREATE TABLE tracks (
  album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  disc       INTEGER NOT NULL DEFAULT 1,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  duration_ms INTEGER,
  PRIMARY KEY (album_id, disc, number)
);

CREATE TABLE events (                    -- append-only audit/history
  id        INTEGER PRIMARY KEY,
  album_id  INTEGER NOT NULL REFERENCES albums(id),
  action    TEXT NOT NULL,               -- added | removed | restored | edited
  at        TEXT NOT NULL,
  source    TEXT NOT NULL,
  detail    TEXT                         -- JSON: reason, changed fields
);
```

- Removing sets `status = 'removed'` and writes an event; the row stays.
  Restoring flips it back. The History page reads `events`, so an album
  removed, restored and removed again shows all three.
- Adding an album that already exists: `listed` → "Already on the list";
  `removed` → offer to restore (Shortcut: restores and says so).
- Tracks are stored so MCP can answer "which album has *Dreams* on it" and the
  list can show running time, without calling Apple every time.

## 4. Adding albums

### 4.1 Parsing the link

Accepted inputs (all from Apple Music share sheets or the browser):

- `https://music.apple.com/ch/album/rumours/594061854`
- `https://music.apple.com/gb/album/rumours/594061854?i=594061862` (a track;
  the album is the path id)
- `https://music.apple.com/ch/song/dreams/594061862` (resolve via lookup →
  `collectionId`)
- `https://geo.music.apple.com/...` and `itunes.apple.com/...` variants

Anything else → 400 with a clear message. Playlists, artists and stations are
rejected.

### 4.2 Metadata

`GET https://itunes.apple.com/lookup?id=<id>&entity=song&country=ch` — public,
no key, returns the collection plus its tracks: name, artist, release date,
genre, track count, `artworkUrl100` (rewritten to `{w}x{h}bb.jpg` for any
size), `collectionViewUrl`. If the album is not in the CH storefront, retry
with `gb`, then `us`. Nothing from Apple is stored beyond this metadata.

`kind` defaults to `studio`. The Worker proposes `live` / `compilation` /
`ep` / `soundtrack` from cues (title contains "Live", "Greatest Hits",
"Best of", " - EP", "Original Soundtrack"; track count ≤ 6; genre
"Soundtrack") and the add form shows the suggestion so I can confirm or keep
it as an exception. The Shortcut accepts the proposal; it can be corrected on
the site later.

### 4.3 On the site

Signed-in only: an **Add** box on `/` (paste link → preview card with artwork,
kind and optional note → Save).

### 4.4 iOS Shortcut

Same pattern as the Supercard Shortcut in `groceries` (docs/SHORTCUT.md there):

1. Receive **URLs** from the **Share Sheet** (shows up when sharing an album
   or song from the Music app).
2. **Get Contents of URL**: `POST https://albums.gcameron.com/api/albums`,
   headers `CF-Access-Client-Id` / `CF-Access-Client-Secret` (a service token
   for this app), JSON body `{ "url": <Shortcut Input>, "source": "shortcut" }`.
3. **Show Notification** with the `summary` field, e.g.
   "Added: Fleetwood Mac – Rumours (1977)" / "Already on the list" /
   "Restored from history".

Optional second Shortcut: **Ask for Input** (note) before posting.

## 5. Display

Public pages, server-rendered, light/dark, works on a phone.

| Route | What |
| --- | --- |
| `/` | Artwork grid (default view). Sort: recently added, artist, year, title. Filters: decade, genre, kind. Search box (artist/title/track). Count in header. |
| `/?view=list` | Compact table: artist, title, year, genre, length, added. Good for scanning a long list. |
| `/?view=play` | Apple Music embed per album (`https://embed.music.apple.com/ch/album/<id>`). Iframes are heavy, so 12 per page and lazy-loaded (`loading="lazy"`, real iframe swapped in on scroll/click). |
| `/albums/:id` | One album: big artwork, the embed player, track list, note, kind, added date, links to Apple Music and to the artist's other listed albums. |
| `/artists/:artistId` | Listed albums by one artist. |
| `/random` | Redirects to a random listed album ("what shall I play?"). |
| `/history` | Removed albums and the change log, newest first. Restore button when signed in. |
| `/about` | What the list is and the rule for getting on it. |
| `/api/albums`, `/api/albums/:id`, `/api/history` | Same data as JSON (public, read-only). |

Signed-in extras on the same pages: Add box, Edit (kind, note), Remove (with
optional reason), Restore. No separate admin UI.

## 6. Access control

- **Public**: every `GET` page and `GET /api/*`.
- **Owner only**: `POST/PATCH/DELETE /api/*`, `/admin/*` (login landing page),
  `/mcp`.
- All writes live under `/admin/*`. A Cloudflare Access application covers
  only `albums.gcameron.com/admin` and `/mcp` (the OAuth login, section 7);
  everything else stays public. Policies:
  - *Allow* my email (one-time PIN or Google login) — browser.
  - *Service Auth* with a service token — the Shortcut.
- The Worker verifies `Cf-Access-Jwt-Assertion` (reuse `src/auth.ts` from
  `groceries`) on every write and fails closed if `ACCESS_AUD` is unset.
- Public pages show edit controls only when a valid Access cookie/JWT is
  present (visiting `/admin` once signs me in for the whole site).
- Preview URLs get their own Access app (as in `groceries`) so preview data and
  write routes are not open.

Resulting write routes: `POST /admin/albums` (add), `PATCH /admin/albums/:id`
(edit), `POST /admin/albums/:id/remove`, `POST /admin/albums/:id/restore`.
The Shortcut posts to `/admin/albums`.

## 7. MCP server

Remote MCP over Streamable HTTP at `https://albums.gcameron.com/mcp`, added in
Claude as a custom connector.

Auth: claude.ai connectors expect OAuth. Use
`@cloudflare/workers-oauth-provider` with Cloudflare Access as the upstream
identity provider (Cloudflare's `remote-mcp-cf-access` pattern): Claude is
sent to Access to log in, the Worker issues its own token, and only my email
is accepted. Token state lives in a small KV namespace. **(assumed)** — the
alternative is a Cloudflare MCP Server Portal in front of the Worker.

Tools (MCP SDK via `agents` / `createMcpHandler`, stateless):

| Tool | Kind | Purpose |
| --- | --- | --- |
| `search_albums` | read | Text search over artist, title, track names; filters for year range, decade, genre, kind, status. |
| `list_albums` | read | Paged list with sort (added, artist, year). |
| `get_album` | read | Full record with tracks, note, events, links. |
| `random_album` | read | One (or n) random listed albums, optional filters ("something from the 80s"). |
| `list_history` | read | Removals/restores/edits, newest first. |
| `get_stats` | read | Counts by decade, genre, kind, artist; total running time; additions per month. |
| `add_album` | write | From an Apple Music URL, optional note and kind. |
| `remove_album` | write | By id, optional reason. |
| `restore_album` | write | By id. |
| `update_album` | write | Kind and note. |

Also expose the list as an MCP **resource** (`albums://list`) for clients that
prefer resources. Responses include `apple_url`, so Claude can hand an album
to the Sonos connector (`play_album`) or look it up on Last.fm.

## 8. Code layout

```
src/
  index.ts        router (fetch), assets fallthrough
  auth.ts         Access JWT verification (from groceries)
  apple.ts        link parsing, iTunes lookup, kind heuristics
  db.ts           queries
  albums.ts       add/remove/restore/edit logic shared by web, Shortcut, MCP
  pages/*.ts      HTML templates (grid, list, play, album, history, about)
  mcp.ts          MCP tools + OAuth provider wiring
migrations/0001_init.sql
public/assets/... css, js, favicon
test/             vitest (link parsing, lookup fixtures, routes, auth)
docs/PLAN.md, docs/SHORTCUT.md
```

No front-end framework: one small `app.js` for the add box, lazy embeds and
filters.

## 9. Build order

| Phase | Scope | Done when |
| --- | --- | --- |
| 0 | Repo fixes (section 2), D1 prod + preview, Workers Builds, CI, empty `/health` | A branch push gives a preview URL; `main` deploys to albums.gcameron.com |
| 1 | Schema, link parsing, iTunes lookup, `POST /admin/albums`, Access + JWT check | Adding by `curl` with a service token works, duplicates handled |
| 2 | Public pages: grid, list, album, about; JSON API | List is browsable on phone and desktop |
| 3 | Play view with lazy Apple Music embeds; `/random` | Albums play in place |
| 4 | Signed-in UI: add box, edit, remove, restore; `/history` | Full lifecycle from the browser |
| 5 | iOS Shortcut + docs/SHORTCUT.md | Share from Music app → notification "Added: …" |
| 6 | MCP server + OAuth via Access; connector added in Claude | Claude can search, pick and add albums |
| 7 | Nice-to-haves: import from an Apple Music playlist or CSV, stats page, artwork colour accents, Last.fm "last played" | — |

## 10. Open questions

1. **Deploys**: move to Workers Builds like `groceries` (recommended), or keep
   GitHub Actions and add a preview job?
2. **Storefront**: links and embeds from the Swiss store (`ch`), or `gb`?
   Availability differs slightly between them.
3. **Starting list**: is there an existing list to import (an Apple Music
   playlist, a note, a spreadsheet)?
4. **Notes and ordering**: a short "why it's here" note per album — public or
   private? Any ranking/favourites, or is being on the list enough?
5. **History visibility**: should `/history` (and removal reasons) be public?
6. **MCP writes**: should Claude be able to add/remove, or read-only with
   adds only through the site and Shortcut?
7. **Login**: Access with one-time PIN to me@gcameron.com, or Google login?
8. **Exceptions**: is `kind` (studio / live / compilation / EP / soundtrack)
   the right granularity, and should non-studio albums be shown with a badge?
