# Backups

`league-backup.json` is a full export of every season — teams, rosters, schedule, games
and box scores — written here nightly by `.github/workflows/backup.yml`.

It exists because the database has no history. Until this migration the git log *was* the
backup: every game arrived as a commit and any mistake could be reverted. Now a league
manager edits things in a browser and D1 keeps only the current state.

`raw/<season>/<game id>.json.gz` holds the original Project Rio uploads exactly as they
arrived, with `raw/manifest.json` listing every one. These are what "re-read file" in the
admin replays, so a parser fix can be applied to games nobody still has on disk. They
never change once written, so the job only fetches the ones it is missing and each is
verified against its recorded checksum before being kept.

## Restoring

The export is the same shape `buildSeasonSnapshot` consumes, so a restore is a matter of
turning it back into inserts. For a total loss:

1. `wrangler d1 create mssb-league` and put the new id in `web/wrangler.jsonc`.
2. `npm run db:migrate -- --remote` to recreate the schema.
3. For Season 1 specifically, `web/migrations/seed/season-1.sql` replays it exactly.
4. For later seasons, write the export back with a short script against
   `web/src/lib/db/admin.ts`, then call `rebuildSnapshot` for each season.
5. To restore the archived uploads, gunzip each file under `raw/` and re-upload it
   through the admin, or insert it into `game_raw` directly.
