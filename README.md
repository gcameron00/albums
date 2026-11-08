# albums

A personal list of albums that are worth playing from start to finish: records
where the whole thing holds up, not just a great track or two. Mostly original
studio albums, no live albums or compilations, with the odd exception.

Hosted at **https://albums.gcameron.com** on Cloudflare (Worker + D1).

## What it does

| Area | Summary |
| --- | --- |
| **Add** | Paste an Apple Music album link on the site, or share it from the Music app through an iOS Shortcut. The Worker looks up title, artist, year, genre, artwork and track list from Apple's public lookup API. |
| **Display** | Public, read-only views, with an optional note per album: an artwork grid, a compact list and a page of playable Apple Music embeds. Sort and filter by artist, year, decade, genre and date added. |
| **Remove** | Signed-in only. A removed album leaves the public list but is kept on a private **History** page with the date and an optional reason, and can be restored. |
| **MCP** | A remote MCP server at `/mcp`, so Claude can be connected to the list: search, browse, pick something to play, look at history, add and remove. Owner only. |
| **Access** | Anyone can view. Editing, history, the Shortcut endpoint and MCP are behind Cloudflare Access (one-time PIN by email) and limited to me. |

## How it works

```
Music app ──share──▶ iOS Shortcut ──POST url──┐
Site (signed in) ──paste link──────────────────┼─▶ Worker ──▶ D1 (albums, history)
Claude ──MCP (OAuth via Cloudflare Access)─────┘      │
                                                      └──▶ itunes.apple.com/lookup (metadata)
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

Phase 0 (repo fixes) done in code: Worker in `src/`, static files in
`public/`, D1 `albums` and `albums-preview` created (WEUR), schema in
`migrations/0001_init.sql`, CI in `.github/workflows/ci.yml`. The site shows a
placeholder home page with the album count and `/health`. Next: Phase 1
(adding albums). See [docs/PLAN.md](docs/PLAN.md), section 9.

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
