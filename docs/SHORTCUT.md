# iOS Shortcut

A Shortcut in the share sheet of the Music app that adds the shared album to
the list. Same pattern as the Supercard Shortcut in `groceries`.

## Before you start

- A service token for this app: Zero Trust → Access → Service credentials →
  Service Tokens → `albums-shortcut`. Keep the Client ID and Client Secret.
- The **Albums admin** Access application has a *Service Auth* policy that
  includes that token.

## Actions

1. **Receive** `URLs` and `Text` from `Share Sheet`. If there is no input:
   Stop and Respond. (Name the Shortcut e.g. *Add to Albums*.)
2. **Get Contents of URL**
   - URL: `https://albums.gcameron.com/admin/albums`
   - Method: `POST` (tap **Show More**)
   - Headers:
     - `CF-Access-Client-Id`: the Client ID (ends in `.access`)
     - `CF-Access-Client-Secret`: the Client Secret
   - Request Body: `JSON`, with two fields:
     - `url` (Text): *Shortcut Input*
     - `source` (Text): `shortcut`
3. **Get Dictionary Value**: **Get** `Value` **for** `summary` **in**
   *Contents of URL*.
4. **Show Notification** with the *Dictionary Value*.

Optional: put **Ask for Input** (Text, prompt "Note?") before step 2 and add
a third JSON field `note` with *Provided Input*.

## What the Worker answers

```json
{
  "outcome": "created",
  "summary": "Added: Depeche Mode – Violator (1990)",
  "album": { "id": 1, "title": "Violator", "artist": "Depeche Mode", "year": 1990, "...": "..." }
}
```

| `outcome` | HTTP | `summary` |
| --- | --- | --- |
| `created` | 201 | `Added: Artist – Title (Year)` |
| `duplicate` | 200 | `Already on the list: …` |
| `restored` | 200 | `Restored from history: …` (it had been removed) |
| — | 400 | Not an album or song link, or a bad body |
| — | 404 | Not available in the CH Apple Music store |
| — | 502 | Apple Music could not be reached |
| — | 401 | No valid Access token (check the headers) |

Song links work too: the album the song is on is added.

## Gotchas (from the Supercard Shortcut)

- **Header values hold only the secret**, not the header name. A wrong value
  gives a `403 Forbidden` page from Cloudflare Access before the Worker sees
  the request.
- **To debug**, add **Show Alert** with *Contents of URL* after step 2. Turn
  off **Show Cancel Button** on it.
- The service token is stored inside the Shortcut. Do not share or export
  it; if it leaks, rotate it in Zero Trust.

## Testing with curl

```sh
curl -sS https://albums.gcameron.com/admin/albums \
  -H "CF-Access-Client-Id: $CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
  -H "content-type: application/json" \
  -d '{"url":"https://music.apple.com/ch/album/violator/665404621?l=en-GB","source":"shortcut"}'
```

For a preview, use the preview URL instead. Previews are behind their own
Access application, which needs the same Service Auth policy.
