# Plan

Draft, 2026-11-08. Decisions so far are in section 10.

## 1. Goals

- One canonical list of "play it start to finish" albums, easy to add to from
  the phone in a couple of taps.
- Pleasant to browse for anyone; playable in place via Apple Music embeds.
- Removals are not lost: they go to a private history list and can be restored.
- Claude can read the list (and, for me, change it) over MCP.
- Same Cloudflare patterns as `groceries`: one Worker, D1, Access, separate
  preview database.

Non-goals for now: multiple users, ratings by others, streaming services other
than Apple Music, scraping Apple Music pages.

## 2. Fix the repo first (Phase 0)

What is wrong today:

| Problem | Fix |
| --- | --- |
| `wrangler.toml` says `name = "generic-website"`; the deploy workflow papers over it with `--name ${{ github.event.repository.name }}`. | `name = "albums"` (matches the deployed Worker). Done. |
| `[assets] directory = "."` publishes the whole repo, which is why `.assetsignore` has to exclude `node_modules`, `package.json`, `wrangler.toml` etc. | Move static files to `public/` and point `[assets]` there. `.assetsignore` goes away. |
| No Worker code (`main`), so no D1, no API. | Add `src/index.ts` as `main`, with `run_worker_first` for everything except `/assets/*`. |
| No previews. The workflow only runs on `main`. | Use **Workers Builds** (Cloudflare's Git integration), as `groceries` does: production build on `main` runs `npm run deploy`; non-production branches run `npm run preview` (`wrangler preview`) with `preview_urls = true` and a `[previews]` block bound to `albums-preview`. |
| `workers_dev = true` exposes an unprotected URL once Access is in front of the custom domain. | `workers_dev = false`; custom domain `albums.gcameron.com` declared in `routes`. |
| Placeholder `index.html` / `about/`. | Replaced by Worker-rendered pages. |
| No tests or CI. | `ci.yml`: `npm ci`, `tsc --noEmit`, `vitest run` on PRs and `main`. |

Cloudflare set-up for Phase 0:

1. ~~Create D1 `albums` and `albums-preview` (location hint WEUR).~~ Done
   2026-11-08 (`b53e925c-…`, `934a0dc8-…`).
2. Connect the repo in Workers Builds (README, *Deployment*). `deploy.yml`
   is deleted, so deploys cannot run twice.
3. Access variables (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) added in Phase 1
   with the first write route.

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
STOREFRONT = "ch"
ACCESS_TEAM_DOMAIN = "grahamcameron.cloudflareaccess.com"
ACCESS_AUD = "<from the Access app>"

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
  note          TEXT,                      -- why it is on the list (optional, public)
  status        TEXT NOT NULL DEFAULT 'listed', -- listed | removed
  added_at      TEXT NOT NULL,
  removed_at    TEXT,
  removed_reason TEXT,                     -- private
  source        TEXT NOT NULL              -- web | shortcut | mcp | import
);
CREATE INDEX albums_status_artist ON albums(status, artist);
CREATE INDEX albums_status_year   ON albums(status, year);

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
  Restoring flips it back. The (owner-only) History page reads `events`, so an album
  removed, restored and removed again shows all three.
- Adding an album that already exists: `listed` → "Already on the list";
  `removed` → offer to restore (Shortcut: restores and says so).
- Track lists are not kept (decided 2026-11-08; `0002_drop_tracks.sql` drops
  the table created in 0001). The Apple Music player on each album page
  shows them, and albums are not searched by track. Only `track_count` and
  `duration_ms` are stored, from the same lookup.

## 4. Adding albums

### 4.1 Parsing the link

Accepted inputs (all from Apple Music share sheets or the browser):

- `https://music.apple.com/ch/album/rumours/594061854`
- `https://music.apple.com/ch/album/rumours/594061854?i=594061862` (a track;
  the album is the path id; links from other storefronts such as `gb` are
  accepted too, since the id is the same everywhere)
- `https://music.apple.com/ch/song/dreams/594061862` (resolve via lookup →
  `collectionId`)
- `https://geo.music.apple.com/...` and `itunes.apple.com/...` variants

Anything else → 400 with a clear message. Playlists, artists and stations are
rejected.

### 4.2 Metadata

Two sources, in order (`src/apple.ts`):

1. **Apple Music API** — `GET api.music.apple.com/v1/catalog/ch/albums/<id>`
   (song links: `songs/<id>?include=albums`), with a developer token: an
   ES256 JWT signed in the Worker from a MusicKit key (`src/musicToken.ts`,
   12-hour tokens, cached). Gives name, artist, artist id, release date,
   genres, track count, artwork URL template (`{w}x{h}`), canonical URL and
   track durations (summed into the album length).
2. **Album page** — when the key is not configured or the API refuses, the
   Worker reads `music.apple.com/ch/album/<id>?l=en-GB` and takes the
   schema.org `MusicAlbum` JSON-LD (track count and durations for the
   length come from its track entries).

The free lookup API (`itunes.apple.com/lookup`) is not used: it answers
HTTP 403 with an empty body to requests from Cloudflare Workers, with or
without a User-Agent (2026-11-08).

Everything uses the Swiss storefront (`ch`): an album not available there is
rejected with a clear message, because its embed would not play. Nothing from
Apple is stored beyond this metadata.

No album type is stored. Whether a live album or compilation belongs on the
list is my call when adding it.

### 4.3 On the site

Signed-in only: an **Add** box on `/` (paste link → preview card with artwork,
optional note → Save).

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
| `/` | Artwork grid (default view). Sort: recently added, artist, year, title. Filters: decade, genre. Search box (artist/title). Count in header. |
| `/?view=list` | Compact table: artist, title, year, genre, length, added. Good for scanning a long list. |
| `/?view=play` | Apple Music embed per album (`https://embed.music.apple.com/ch/album/<id>`). Iframes are heavy, so 12 per page with native `loading="lazy"`. |
| `/albums/:id` | One album: big artwork, the embed player (which lists the tracks), note, added date, links to Apple Music and to the artist's other listed albums. |
| `/?artist=<name>` | Listed albums by one artist (artist links point here; no separate artist route, since page-sourced albums have no artist id). |
| `/random` | Redirects to a random listed album ("what shall I play?"), honouring search and filters. Linked as *Random* in the header and *Play something* on the list. |
| `/about` | What the list is and the rule for getting on it. |
| `/api/albums`, `/api/albums/:id` | Same data as JSON (public, read-only; listed albums only, no removal data). |
| `/admin/history` | **Owner only.** Removed albums (with reasons) and the change log, newest first, with Restore buttons. |

Removed albums are not shown anywhere public (a removed album's page returns
404). Owner pages live under `/admin` (add form, edit page per album with
note and Remove, history with Put back); album pages link to their edit page
when an Access session cookie is present.

## 6. Access control

- **Public**: every `GET` page and `GET /api/*`, listed albums only.
- **Owner only**: `/admin/*` (all writes and the history page) and `/mcp`.
- All writes live under `/admin/*`. The Access application **Albums admin**
  covers only `albums.gcameron.com/admin`; everything else stays public.
  `/mcp` is *not* behind it: Claude calls `/mcp` with a token the Worker
  issues, which Access would block (section 7). Policies (set up 2026-11-08):
  - *Allow* me@gcameron.com, one-time PIN by email — browser.
  - *Service Auth* with service token `albums-shortcut` — the Shortcut.
    (Not *Bypass*: Bypass skips Access, so no JWT would reach the Worker.)
- The Worker verifies `Cf-Access-Jwt-Assertion` (reuse `src/auth.ts` from
  `groceries`) on every write and fails closed if `ACCESS_AUD` is unset.
- Album pages show an *Edit* link (to `/admin/albums/:id`) when the
  `CF_Authorization` cookie is present. Only the link depends on the cookie;
  the edit page itself is behind Access and the JWT check. Visiting `/admin`
  once signs me in.
- Preview URLs get their own Access app (as in `groceries`) so preview data and
  write routes are not open.

Resulting owner routes: `GET /admin/history`, `POST /admin/albums` (add),
`GET`/`POST /admin/albums/:id` (edit page; save note), `POST /admin/albums/:id/remove`,
`POST /admin/albums/:id/restore`. Each POST takes a same-origin form
(answered with a redirect) or JSON (answered with JSON).
The Shortcut posts to `/admin/albums`.

## 7. MCP server

Remote MCP over Streamable HTTP at `https://albums.gcameron.com/mcp`, added in
Claude as a custom connector. Implemented in `src/mcp.ts` without an SDK:
stateless JSON-RPC, one message per POST, JSON responses (no SSE stream),
notifications answered with 202.

**Auth** (`src/index.ts`, `src/oauth.ts`): `@cloudflare/workers-oauth-provider`
handles dynamic client registration (`/oauth/register`), tokens
(`/oauth/token`, with refresh) and the `/.well-known` metadata, with state in
KV (`OAUTH_KV`; `albums-oauth`, and `albums-oauth-preview` for previews).
Its authorize endpoint is `/admin/authorize`, inside the existing **Albums
admin** Access application, so no second Access app is needed: Access asks
for the one-time PIN, the Worker checks the Access JWT carries an email (not
a service token), and a consent page names the client and where it returns
to. Only *Allow* (a same-origin form post) issues a token, with props
`{ email }`; `/mcp` refuses requests without them. `/oauth/*` and
`/.well-known/*` are outside Access because Claude's servers call them.

Tools (all owner-only; the token implies the owner):

| Tool | Kind | Purpose |
| --- | --- | --- |
| `search_albums` | read | Artist/title words, exact artist, decade, genre; sort and direction; 200 per page with total. |
| `get_album` | read | One album by id, including removed ones (status, removal date and reason). |
| `random_album` | read | 1–10 random listed albums, same filters ("something from the 80s"). |
| `get_stats` | read | Totals, length, by decade, by genre, artists with several albums, additions per month. |
| `list_history` | read | Removed albums with reasons, and the latest changes. |
| `add_album` | write | From an Apple Music album or song link, optional note; duplicate/restore handled. |
| `update_note` | write | Set or clear the public note. |
| `remove_album` | write | Off the list into the private history, optional reason. |
| `restore_album` | write | Put a removed album back. |

Results come as JSON text plus `structuredContent`. Each album includes
`apple_url` and its page URL, so Claude can hand it to the Sonos connector
(`play_album`) or look it up on Last.fm. Writes are logged with source `mcp`.

## 8. Code layout

```
src/
  index.ts        entry: OAuth provider in front of the site and /mcp
  app.ts          router for the site and public API
  http.ts         responses, body reading, same-origin checks
  auth.ts         Access JWT verification (from groceries)
  apple.ts        link parsing, Apple Music API and album-page fallback
  musicToken.ts   Apple Music developer token (MusicKit key)
  albums.ts       add/remove/restore/edit logic shared by web, Shortcut, MCP
  catalog.ts      read queries (list, filters, random, history)
  pages.ts        public HTML pages
  admin.ts        owner pages and writes under /admin
  oauth.ts        consent page for connecting Claude
  mcp.ts          MCP JSON-RPC server and tools
  format.ts, html.ts
migrations/       D1 schema
public/assets/    CSS, JS, favicon
test/             vitest (in-memory SQLite D1, hand-written Apple fixtures)
docs/             PLAN.md, SHORTCUT.md
```

No front-end framework: one small `filters.js` applies list filters as they
change.

## 9. Build order

| Phase | Scope | Done when |
| --- | --- | --- |
| 0 | Repo fixes (section 2), D1 prod + preview, Workers Builds, CI, empty `/health` | A branch push gives a preview URL; `main` deploys to albums.gcameron.com. **Done** |
| 1 | Schema, link parsing, iTunes lookup, `POST /admin/albums`, Access + JWT check | Adding by `curl` with a service token works, duplicates handled. **Done** (Shortcut verified 2026-11-08) |
| 2 | Public pages: grid, list, album, about; JSON API | List is browsable on phone and desktop. **Done** |
| 3 | Play view with lazy Apple Music embeds; `/random` | Albums play in place. **Done** |
| 4 | Signed-in UI: add box, edit, remove, restore; `/admin/history`; list view sortable by column heading | Full lifecycle from the browser. **Done** |
| 5 | iOS Shortcut ([docs/SHORTCUT.md](SHORTCUT.md)) — **Done** | Share from Music app → notification "Added: …" |
| 6 | MCP server + OAuth via Access; connector added in Claude | Claude can search, pick and add albums. **Code done** |
| 7 | Nice-to-haves: import from examples or an Apple Music playlist, stats page, artwork colour accents, Last.fm "last played" | — |

## 10. Decisions (2026-11-08)

1. **Deploys**: Workers Builds, as in `groceries`. `deploy.yml` is retired.
2. **Storefront**: Swiss (`ch`) for lookups, links and embeds.
3. **Starting list**: none to import; examples to come for testing.
4. **Notes**: yes, one free-text note per album, public. No ranking or
   favourites: everything on the list is a favourite of some kind.
5. **History**: private. Removed albums and reasons are owner-only.
6. **MCP**: read and write (add, remove, restore, edit note), owner only.
7. **Login**: Cloudflare Access, one-time PIN by email. I configure the
   policies in Zero Trust when we reach Phase 1.
8. **Album type**: dropped. No `kind` column, no badges.
