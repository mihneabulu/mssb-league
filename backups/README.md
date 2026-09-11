# Backups

`league-backup.json` is a full export of every season — teams, rosters, schedule, games
and box scores — written here nightly by `.github/workflows/backup.yml`.

It exists because the database has no history. Until this migration the git log *was* the
backup: every game arrived as a commit and any mistake could be reverted. Now a league
manager edits things in a browser and D1 keeps only the current state.

**What it does not contain:** the archived original Project Rio uploads. Those are stored
in D1 (`game_raw`) and are only needed to re-parse a game after a parser fix, not to
rebuild the league. Season 1's originals are still in `results/` in this repo.

## Restoring

The export is the same shape `buildSeasonSnapshot` consumes, so a restore is a matter of
turning it back into inserts. For a total loss:

1. `wrangler d1 create mssb-league` and put the new id in `web/wrangler.jsonc`.
2. `npm run db:migrate -- --remote` to recreate the schema.
3. For Season 1 specifically, `web/migrations/seed/season-1.sql` replays it exactly.
4. For later seasons, write the export back with a short script against
   `web/src/lib/db/admin.ts`, then call `rebuildSnapshot` for each season.
