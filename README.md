# albums

A personal list of albums that are worth playing from start to finish: records
where the whole thing holds up, not just a great track or two. Mostly original
studio albums, no live albums or compilations, with the odd exception.

Hosted at **https://albums.gcameron.com** on Cloudflare (Worker + D1).

## What it does

| Area | Summary |
| --- | --- |
| **Add** | Paste an Apple Music album link on the site, or share it from the Music app through an iOS Shortcut. The Worker looks up title, artist, year, genre, artwork and track list from Apple's public lookup API. |
| **Display** | Public, read-only views: an artwork grid, a compact list and a page of playable Apple Music embeds. Sort and filter by artist, year, decade, genre and date added. |
| **Remove** | Signed-in only. A removed album leaves the list but moves to a public **History** page with the date (and an optional reason), and can be restored. |
| **MCP** | A remote MCP server at `/mcp`, so Claude can be connected to the list: search, browse, pick something to play, look at history and (owner only) add or remove. |
| **Access** | Anyone can view. Editing, the Shortcut endpoint and MCP are behind Cloudflare Access and limited to me. |

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

Planning. The placeholder site from the template is deployed as the Worker
`albums`. Nothing below is built yet.

## Development (once Phase 0 lands)

```sh
npm install
npm run db:migrate:local   # apply migrations to the local D1
npm run dev                # wrangler dev on http://localhost:8787
npm test
```

Deploys: pushes to `main` deploy production; other branches get a preview URL
backed by the preview database (see the plan, section 2).
