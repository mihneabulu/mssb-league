// The season snapshot: one precomputed JSON blob per season, rebuilt on every write.
//
// A whole season aggregates to ~11 KB gzipped, so recomputing all of it on write and
// serving a single row on read is both simpler and faster than maintaining incremental
// stats. Public pages never touch the games table.

import { buildSeasonSnapshot } from '../mssb/aggregate.ts';
import type { SeasonSnapshot } from '../mssb/types.ts';
import { loadSeasonInput } from './queries.ts';
import type { Executable, Queryable } from './queries.ts';

export type SeasonListEntry = {
  slug: string;
  shortLabel: string;
  status: string;
  isCurrent: boolean;
};

export type LoadedSnapshot = {
  snapshot: SeasonSnapshot;
  version: number;
  etag: string;
};

/**
 * Read a season's stored snapshot. Falls back to building one on the fly if the row is
 * missing, so a season is never unviewable just because a rebuild was skipped.
 */
export async function getSnapshot(
  db: Queryable,
  seasonSlug: string | null,
): Promise<LoadedSnapshot | null> {
  const rows = seasonSlug
    ? await db.all(
        `SELECT s.slug, ss.version, ss.etag, ss.payload
         FROM seasons s LEFT JOIN season_snapshots ss ON ss.season_id = s.id
         WHERE s.slug = ?`,
        [seasonSlug],
      )
    : await db.all(
        `SELECT s.slug, ss.version, ss.etag, ss.payload
         FROM seasons s LEFT JOIN season_snapshots ss ON ss.season_id = s.id
         WHERE s.is_current = 1`,
      );

  const row = rows[0];
  if (!row) return null;

  if (row.payload) {
    return {
      snapshot: JSON.parse(String(row.payload)) as SeasonSnapshot,
      version: Number(row.version ?? 1),
      etag: String(row.etag ?? `${row.slug}-1`),
    };
  }

  const input = await loadSeasonInput(db, String(row.slug));
  if (!input) return null;
  const snapshot = buildSeasonSnapshot(input);
  return { snapshot, version: 0, etag: `${row.slug}-0` };
}

/** Every season, newest first — for the nav's season switcher. */
export async function listSeasons(db: Queryable): Promise<SeasonListEntry[]> {
  const rows = await db.all(
    `SELECT slug, short_label, status, is_current FROM seasons
     ORDER BY start_date DESC, id DESC`,
  );
  return rows.map((r) => ({
    slug: String(r.slug),
    shortLabel: String(r.short_label),
    status: String(r.status),
    isCurrent: Boolean(Number(r.is_current)),
  }));
}

/** The slug the bare domain should resolve to. */
export async function getCurrentSeasonSlug(db: Queryable): Promise<string | null> {
  const rows = await db.all(`SELECT slug FROM seasons WHERE is_current = 1`);
  return rows[0] ? String(rows[0].slug) : null;
}

/**
 * The cache key ingredient. Held briefly in module scope so a burst of requests to the
 * same isolate does not re-query D1 for a number that changes a few times a week; the
 * memo is also the upper bound on how stale a page can be after a write.
 */
const VERSION_MEMO_MS = 5_000;
const versionMemo = new Map<string, { value: number; at: number }>();

export async function getSeasonVersion(db: Queryable, seasonSlug: string): Promise<number> {
  const hit = versionMemo.get(seasonSlug);
  const now = Date.now();
  if (hit && now - hit.at < VERSION_MEMO_MS) return hit.value;

  const rows = await db.all(
    `SELECT ss.version FROM seasons s
     JOIN season_snapshots ss ON ss.season_id = s.id
     WHERE s.slug = ?`,
    [seasonSlug],
  );
  const value = rows[0] ? Number(rows[0].version) : 0;
  versionMemo.set(seasonSlug, { value, at: now });
  return value;
}

/** Drop the memo so the very next request sees a just-written version. */
export function forgetSeasonVersion(seasonSlug: string): void {
  versionMemo.delete(seasonSlug);
}

/**
 * Recompute a season's snapshot and bump its version.
 *
 * Called after every mutation. Six reads plus one upsert — cheap enough that there is no
 * reason to ever serve stale aggregates, and bumping `version` is what invalidates the
 * edge cache (by rotating the key, since a Worker cannot purge other colos).
 */
export async function rebuildSnapshot(
  db: Executable,
  seasonSlug: string,
): Promise<{ version: number; etag: string } | null> {
  const input = await loadSeasonInput(db, seasonSlug);
  if (!input) return null;

  const rows = await db.all(`SELECT id FROM seasons WHERE slug = ?`, [seasonSlug]);
  if (!rows[0]) return null;
  const seasonId = Number(rows[0].id);

  // Box scores stay out: they are ~half the payload and only one game's page needs them.
  const snapshot = buildSeasonSnapshot(input, { includeBoxscores: false });
  const payload = JSON.stringify(snapshot);
  const builtAt = Math.floor(Date.now() / 1000);

  const existing = await db.all(
    `SELECT version FROM season_snapshots WHERE season_id = ?`,
    [seasonId],
  );
  const version = (existing[0] ? Number(existing[0].version) : 0) + 1;
  const etag = `${seasonSlug}-${version}`;

  await db.run(
    `INSERT INTO season_snapshots (season_id, version, built_at, etag, payload)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (season_id) DO UPDATE SET
       version = excluded.version,
       built_at = excluded.built_at,
       etag = excluded.etag,
       payload = excluded.payload`,
    [seasonId, version, builtAt, etag, payload],
  );

  forgetSeasonVersion(seasonSlug);
  return { version, etag };
}
