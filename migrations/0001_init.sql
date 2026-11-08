-- Albums on the list (status 'listed') and removed ones (status 'removed').
-- Removed rows are kept for the private history; see docs/PLAN.md section 3.
CREATE TABLE albums (
  id             INTEGER PRIMARY KEY,
  apple_id       TEXT NOT NULL UNIQUE,
  storefront     TEXT NOT NULL DEFAULT 'ch',
  title          TEXT NOT NULL,
  artist         TEXT NOT NULL,
  artist_id      TEXT,
  release_date   TEXT,
  year           INTEGER,
  genre          TEXT,
  track_count    INTEGER,
  duration_ms    INTEGER,
  artwork_url    TEXT,
  apple_url      TEXT NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'removed')),
  added_at       TEXT NOT NULL,
  removed_at     TEXT,
  removed_reason TEXT,
  source         TEXT NOT NULL CHECK (source IN ('web', 'shortcut', 'mcp', 'import'))
);
CREATE INDEX albums_status_artist ON albums (status, artist);
CREATE INDEX albums_status_year ON albums (status, year);
CREATE INDEX albums_status_added ON albums (status, added_at);

CREATE TABLE tracks (
  album_id    INTEGER NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  disc        INTEGER NOT NULL DEFAULT 1,
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  duration_ms INTEGER,
  PRIMARY KEY (album_id, disc, number)
);

-- Append-only log: added | removed | restored | edited.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  album_id INTEGER NOT NULL REFERENCES albums (id),
  action   TEXT NOT NULL CHECK (action IN ('added', 'removed', 'restored', 'edited')),
  at       TEXT NOT NULL,
  source   TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX events_at ON events (at);
