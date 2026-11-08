# albums

A personal list of albums that are worth playing from start to finish: records
where the whole thing holds up, not just a great track or two. Mostly original
studio albums, no live albums or compilations, with the odd exception.

Hosted at **https://albums.gcameron.com** on Cloudflare (Worker + D1).

## What it does

| Area | Summary |
| --- | --- |
| **Add** | Paste an Apple Music album link on the site, or share it from the Music app through an iOS Shortcut. The Worker looks up title, artist, year, genre, artwork and track list from the Apple Music API (or, without a key, the album's Apple Music page). |
| **Display** | Public, read-only views, with an optional note per album: an artwork grid, a compact list and a page of playable Apple Music embeds. Sort and filter by artist, year, decade, genre and date added. |
| **Remove** | Signed-in only. A removed album leaves the public list but is kept on a private **History** page with the date and an optional reason, and can be restored. |
| **MCP** | A remote MCP server at `/mcp`, so Claude can be connected to the list: search, browse, pick something to play, look at history, add and remove. Owner only. |
| **Access** | Anyone can view. Editing, history, the Shortcut endpoint and MCP are behind Cloudflare Access (one-time PIN by email) and limited to me. |

## How it works

```
Music app ──share──▶ iOS Shortcut ──POST url──┐
Site (signed in) ──paste link──────────────────┼─▶ Worker ──▶ D1 (albums, history)
Claude ──MCP (OAuth via Cloudflare Access)─────┘      │
                                                      └──▶ Apple Music API (metadata)
Visitors ──GET──▶ Worker ──▶ HTML pages + Apple Music embeds
```

- **Worker**: TypeScript, server-rendered HTML, static files from `public/`.
- **D1**: `albums` for production, `albums-preview` for preview builds. Previews
  never touch production data.
- **Auth**: Cloudflare Access protects the write routes and `/mcp`. The Worker
  also verifies the Access JWT itself and fails closed.

See [docs/PLAN.md](docs/PLAN.md) for the data model, routes, MCP tools,
deployment set-up and the build order.

## Status

- **Phase 0** (repo fixes, D1, previews, CI): done.
- **Phase 1** (adding albums): done. `POST /admin/albums` behind Cloudflare
  Access; the iOS Shortcut ([docs/SHORTCUT.md](docs/SHORTCUT.md)) works.
  Album details come from the album's Apple Music page until the Apple Music
  API key is set up ([#5](https://github.com/gcameron00/albums/issues/5)).
- **Phase 2** (public pages): cover grid and list, filters, search, album
  pages with player and tracks, About, read-only JSON API.

Next: Phase 3 (play view, random pick). See [docs/PLAN.md](docs/PLAN.md),
section 9.

## Routes

| Route | Method | Access | Returns |
| --- | --- | --- | --- |
| `/` | GET | public | Cover grid of listed albums. Parameters: `q` (search artist, album and track names), `artist`, `decade` (e.g. `1980`), `genre`, `sort` (`added`, `artist`, `year`, `title`), `view` (`grid`, `list`), `page` |
| `/albums/:id` | GET | public | One album: cover, facts, note, Apple Music player (which lists the tracks), more by the artist. 404 if removed |
| `/about` | GET | public | What the list is |
| `/api/albums` | GET | public | The list as JSON, same parameters as `/`; `{total, page, page_size, albums}`. CORS open |
| `/api/albums/:id` | GET | public | One album with `tracks` as JSON |
| `/health` | GET | public | `{"ok":true}` |
| `/admin` | GET | Access | Who is signed in |
| `/admin/albums` | POST | Access | Add an album. JSON body `{"url": "<Apple Music link>", "note": "…", "source": "web\|shortcut\|mcp"}`; answers `{outcome, summary, album}` (see [docs/SHORTCUT.md](docs/SHORTCUT.md)) |

Removed albums never appear on public pages or in the API.

## Deployment

Deploys run on **Workers Builds** (Cloudflare's Git integration), not GitHub
Actions:

| Branch | Command | Database | URL |
| --- | --- | --- | --- |
| `main` | `npm run deploy` (migrate, then `wrangler deploy`) | `albums` | https://albums.gcameron.com |
| any other | `npm run preview` (migrate, then `wrangler preview`) | `albums-preview` | Preview URL shown on the build / PR |

One-time set-up in the Cloudflare dashboard (Workers & Pages → `albums` →
Settings → Build):

1. **Connect** the GitHub repo `gcameron00/albums`; production branch `main`.
2. Build command: leave empty. Deploy command: `npm run deploy`.
3. Enable **non-production branch builds** with deploy command
   `npm run preview`.
4. The build token needs Workers Scripts and D1 edit rights (the default
   token Workers Builds creates has them).

The GitHub repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
were only used by the old `deploy.yml` and can be deleted.

## Apple Music API key

Album details come from the Apple Music API when a MusicKit key is set;
without one the Worker reads the album's music.apple.com page instead.

1. [developer.apple.com](https://developer.apple.com/account) → Certificates,
   Identifiers & Profiles → **Identifiers** → **+** → *Media IDs* →
   description `Albums`, identifier `media.com.gcameron.albums`, tick
   **MusicKit**.
2. **Keys** → **+** → name `Albums MusicKit`, tick **Media Services
   (MusicKit, ShazamKit, Apple Music Feed)** → Configure → choose the Media ID
   from step 1 → Continue → Register. **Download** the `.p8` file (only
   possible once) and note the **Key ID**.
3. Your **Team ID** is under Membership details.
4. Put Team ID and Key ID in `wrangler.toml` as `APPLE_TEAM_ID` and
   `APPLE_KEY_ID` (in `[vars]` and `[previews.vars]`). They are not secret.
5. Store the key as a secret, the whole `.p8` contents including the
   `BEGIN`/`END` lines: Workers & Pages → `albums` → Settings → Variables and
   Secrets → Add → type **Secret**, name `APPLE_MUSIC_KEY`. (Or
   `npx wrangler secret put APPLE_MUSIC_KEY < AuthKey_XXXXXXXXXX.p8`.)

If the key cannot be read, the Worker logs "Apple Music key could not be
used" and falls back to the album page.

## Development

```sh
npm install
npm run db:migrate:local   # apply migrations to the local D1
npm run dev                # wrangler dev on http://localhost:8787
npm run typecheck
npm test
```

No lockfile is committed yet (the first commit was written without registry
access). Run `npm install` once and commit `package-lock.json`, then switch CI
to `npm ci`.
