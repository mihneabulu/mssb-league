-- Let a season put the same character on more than one team.
--
-- Season 1 drafted from an exclusive pool: 6 teams x 9 characters, every pick unique,
-- and `roster_slots`' primary key (season_id, char_id) enforced that. A later draft
-- wanted duplicates, so exclusivity becomes a per-season choice instead of a schema-wide
-- law — and stays enforced by the database either way.
--
-- The trick is `dup_scope`: 0 while a season keeps characters exclusive, the owning
-- team's id once it allows duplicates. UNIQUE (season_id, char_id, dup_scope) is then
-- literally the old primary key in the first case, and per-team uniqueness in the
-- second. Flipping the season toggle rewrites the column (see setDuplicateChars), so
-- there is never a window where the constraint is merely a convention in TypeScript.

ALTER TABLE seasons ADD COLUMN allow_duplicate_chars INTEGER NOT NULL DEFAULT 0;

-- SQLite cannot alter a primary key, so the table is rebuilt. Nothing references
-- roster_slots, so this is a copy, a drop and a rename.
CREATE TABLE roster_slots_new (
  season_id  INTEGER NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  char_id    INTEGER NOT NULL CHECK (char_id BETWEEN 0 AND 53),
  is_captain INTEGER NOT NULL DEFAULT 0,
  pick_order INTEGER,
  dup_scope  INTEGER NOT NULL DEFAULT 0,
  -- A team still cannot draft the same character twice, whatever the season allows.
  PRIMARY KEY (season_id, team_id, char_id)
);

INSERT INTO roster_slots_new (season_id, team_id, char_id, is_captain, pick_order, dup_scope)
  SELECT season_id, team_id, char_id, is_captain, pick_order, 0 FROM roster_slots;

DROP TABLE roster_slots;

ALTER TABLE roster_slots_new RENAME TO roster_slots;

CREATE UNIQUE INDEX roster_char_scope ON roster_slots (season_id, char_id, dup_scope);
CREATE INDEX roster_by_team ON roster_slots (team_id);
