-- Initial schema for the league database.
--
-- Everything is scoped to a season and keyed by id — nothing is keyed by team NAME,
-- because a fresh draft each season means names, colours and rosters can all change
-- while the same character ids get redistributed.
--
-- Two D1 limits shape the design and are worth remembering before adding tables:
--   * 50 queries per Worker invocation — so a game's box score is one JSON column
--     rather than 18 rows (a 3-game batch commit would otherwise be 54 statements).
--   * 100 bound parameters per query — so bulk schedule saves must be chunked.

PRAGMA foreign_keys = ON;

CREATE TABLE seasons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,          -- 's1', 's2'
  name        TEXT    NOT NULL,                 -- full title, shown in the footer
  short_label TEXT    NOT NULL,                 -- 'Season 1 · 2026', shown on the homepage
  start_date  TEXT    NOT NULL,                 -- 'YYYY-MM-DD'
  rounds      INTEGER NOT NULL DEFAULT 10,
  status      TEXT    NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'complete', 'archived')),
  is_current  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Exactly one season can be the current one; the site's root URLs resolve to it.
CREATE UNIQUE INDEX seasons_one_current ON seasons (is_current) WHERE is_current = 1;

CREATE TABLE teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id       INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  slug            TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  color           TEXT    NOT NULL DEFAULT '#888888',
  captain_char_id INTEGER,
  stadium_id      INTEGER,                      -- 0..5; a stadium ID, never a name
  sort_order      INTEGER NOT NULL DEFAULT 0,   -- preserves the league's own team order
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (season_id, slug),
  UNIQUE (season_id, name)
);

CREATE INDEX teams_by_season ON teams (season_id);

-- A character belongs to at most one team per season. That constraint IS the primary
-- key, so double-drafting is a database error rather than something the UI has to
-- remember to check.
CREATE TABLE roster_slots (
  season_id  INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  char_id    INTEGER NOT NULL CHECK (char_id BETWEEN 0 AND 53),
  is_captain INTEGER NOT NULL DEFAULT 0,
  pick_order INTEGER,                           -- unused for now; a draft board can fill it
  PRIMARY KEY (season_id, char_id)
);

CREATE INDEX roster_by_team ON roster_slots (team_id);

CREATE TABLE rounds (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  round_no  INTEGER NOT NULL,
  label     TEXT,                               -- e.g. 'Round 6 (makeup)'
  starts_on TEXT,
  UNIQUE (season_id, round_no)
);

CREATE TABLE matchups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id    INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  round_id     INTEGER NOT NULL REFERENCES rounds (id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL REFERENCES teams (id),
  home_team_id INTEGER NOT NULL REFERENCES teams (id),
  UNIQUE (round_id, slot)
);

CREATE INDEX matchups_by_season ON matchups (season_id, round_id);

-- The original uploaded file, gzipped. ~17 KB per game including the Events log, which
-- nothing reads but which makes "re-parse from raw" possible after a parser fix.
CREATE TABLE game_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id   INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  rio_game_id TEXT    NOT NULL,
  sha256      TEXT    NOT NULL UNIQUE,          -- byte-identical re-upload dedupe
  filename    TEXT,
  bytes_gz    BLOB    NOT NULL,
  size_raw    INTEGER NOT NULL,
  size_gz     INTEGER NOT NULL,
  was_decoded INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  uploaded_by TEXT
);

CREATE TABLE games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id      INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  rio_game_id    TEXT    NOT NULL,
  -- Which scheduled round this counts as: a human-confirmed fact, stored once, replacing
  -- both the week-NN folder name and the frontend's render-time greedy pair matching.
  round_id       INTEGER REFERENCES rounds (id) ON DELETE SET NULL,
  matchup_id     INTEGER REFERENCES matchups (id) ON DELETE SET NULL,
  away_team_id   INTEGER NOT NULL REFERENCES teams (id),
  home_team_id   INTEGER NOT NULL REFERENCES teams (id),
  away_score     INTEGER NOT NULL,
  home_score     INTEGER NOT NULL,
  innings_played INTEGER NOT NULL,
  stadium_id     INTEGER NOT NULL,
  played_at      INTEGER NOT NULL,              -- unix seconds ("Date - Start")
  ended_at       INTEGER,
  quitter_team   INTEGER,
  detection      TEXT    NOT NULL DEFAULT '{}', -- JSON: how each side was identified
  box_json       TEXT    NOT NULL,              -- JSON {away:[9], home:[9]}, ~6.7 KB
  raw_id         INTEGER REFERENCES game_raw (id) ON DELETE SET NULL,
  source_name    TEXT,
  uploaded_by    TEXT,
  uploaded_at    INTEGER NOT NULL,
  notes          TEXT,
  UNIQUE (season_id, rio_game_id)
);

CREATE INDEX games_by_season_date ON games (season_id, played_at);
CREATE INDEX games_by_round ON games (round_id);

-- The whole season aggregated into one JSON blob (~11 KB gzipped). Public pages read
-- this single row; a write recomputes it and bumps `version`, which rotates the cache key.
CREATE TABLE season_snapshots (
  season_id INTEGER PRIMARY KEY REFERENCES seasons (id) ON DELETE CASCADE,
  version   INTEGER NOT NULL DEFAULT 1,
  built_at  INTEGER NOT NULL,
  etag      TEXT    NOT NULL,
  payload   TEXT    NOT NULL
);

-- Uploads are staged server-side so the review survives a reload and a partial commit is
-- recoverable — raw files are 316 KB each, too big to shuttle back and forth.
CREATE TABLE upload_batches (
  id         TEXT PRIMARY KEY,                  -- crypto.randomUUID()
  season_id  INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  created_by TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'committed', 'discarded'))
);

CREATE TABLE staged_games (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id         TEXT    NOT NULL REFERENCES upload_batches (id) ON DELETE CASCADE,
  filename         TEXT    NOT NULL,
  status           TEXT    NOT NULL,            -- ok | needs_review | duplicate | error
  error            TEXT,
  analyzed_json    TEXT    NOT NULL,            -- AnalyzedGame minus the raw bytes
  raw_gz           BLOB    NOT NULL,
  sha256           TEXT    NOT NULL,
  sug_away_team_id INTEGER,
  sug_home_team_id INTEGER,
  sug_round_id     INTEGER,
  confidence       TEXT                         -- exact | fuzzy | none
);

CREATE INDEX staged_by_batch ON staged_games (batch_id);

CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  actor     TEXT    NOT NULL,                   -- Cloudflare Access email
  action    TEXT    NOT NULL,
  season_id INTEGER,
  entity    TEXT,
  entity_id TEXT,
  detail    TEXT
);

CREATE INDEX audit_recent ON audit_log (at DESC);
