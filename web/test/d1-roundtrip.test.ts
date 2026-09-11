// Parity a second time, but through the database.
//
// The pure test proves the aggregation is right. This one proves the schema, the seed
// SQL and the row mapping are right too — and it is where migrations usually break:
// SQLite has no boolean type, so `captain` comes back as 0/1; INTEGER/REAL coercion can
// turn 3 into 3.0; JSON columns round-trip through a string. None of that is visible
// until the data has actually been through SQLite.
//
// D1 is SQLite, so node:sqlite is a faithful stand-in and needs no wrangler, no network
// and no local state — meaning this runs in CI like any other test.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildSeasonSnapshot } from '../src/lib/mssb/aggregate.ts';
import type { Queryable, Row } from '../src/lib/db/queries.ts';
import { loadSeasonInput } from '../src/lib/db/queries.ts';
import type { SeasonInput } from '../src/lib/mssb/types.ts';
import { diff, formatDiffs } from './diff.ts';
import { REPO_ROOT } from './legacy-context.ts';
import { loadLegacySeason } from './legacy.ts';

const golden = JSON.parse(
  readFileSync(join(REPO_ROOT, 'web/test/fixtures/season-1.golden.json'), 'utf8'),
);

let loaded: SeasonInput;

beforeAll(async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(REPO_ROOT, 'web/migrations/0001_init.sql'), 'utf8'));
  db.exec(readFileSync(join(REPO_ROOT, 'web/migrations/seed/season-1.sql'), 'utf8'));

  const queryable: Queryable = {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as never[])) as unknown as Row[];
    },
  };

  const result = await loadSeasonInput(queryable, 's1');
  expect(result, 'season s1 should load from the seeded database').not.toBeNull();
  loaded = result!;
});

describe('Season 1 survives a round trip through SQLite', () => {
  it('loads the season, teams and games back out', () => {
    expect(loaded.season.slug).toBe('s1');
    expect(loaded.teams).toHaveLength(6);
    expect(loaded.games).toHaveLength(14);
    expect(loaded.schedule).toHaveLength(10);
  });

  it('restores booleans, not SQLite 0/1', () => {
    for (const team of loaded.teams) {
      for (const member of team.roster) {
        expect(typeof member.captain, `${team.name} #${member.charId}`).toBe('boolean');
      }
      const captains = team.roster.filter((m) => m.captain);
      expect(captains, `${team.name} should have exactly one captain`).toHaveLength(1);
      expect(captains[0].charId).toBe(team.captainCharId);
    }
  });

  it('restores the box score as objects with numeric stats', () => {
    const player = loaded.games[0].boxscore.away[0];
    expect(typeof player.charId).toBe('number');
    expect(typeof player.captain).toBe('boolean');
    expect(typeof player.batting.avg).toBe('number');
  });

  it('gives every game its stored round', () => {
    expect(loaded.games.every((g) => typeof g.round === 'number')).toBe(true);
  });

  it('matches the season input built straight from the legacy files', () => {
    const fromFiles = loadLegacySeason().input;
    const diffs = diff(fromFiles, loaded, 'input');
    expect(diffs, formatDiffs(diffs)).toEqual([]);
  });

  it('rebuilds a snapshot identical to build.py output', () => {
    const snapshot = buildSeasonSnapshot(loaded, {
      includeBoxscores: true,
      generatedAt: golden.generatedAt,
    });

    expect(snapshot.standings).toEqual(golden.standings);

    const teamDiffs = diff(golden.teams, snapshot.teams, 'teams');
    expect(teamDiffs, formatDiffs(teamDiffs)).toEqual([]);

    const charDiffs = diff(golden.characters, snapshot.characters, 'characters');
    expect(charDiffs, formatDiffs(charDiffs)).toEqual([]);

    const leaderDiffs = diff(golden.leaders, snapshot.leaders, 'leaders');
    expect(leaderDiffs, formatDiffs(leaderDiffs)).toEqual([]);

    const expectedGames = golden.games.map((g: Record<string, unknown>) => {
      const { week: _week, file: _file, ...rest } = g;
      return rest;
    });
    const actualGames = snapshot.games.map((g) => {
      const { round: _round, ...rest } = g;
      return rest;
    });
    const gameDiffs = diff(expectedGames, actualGames, 'games');
    expect(gameDiffs, formatDiffs(gameDiffs)).toEqual([]);

    expect(snapshot.schedule).toEqual(golden.schedule);
  });

  it('keeps the raw uploads, gzipped and checksummed', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(join(REPO_ROOT, 'web/migrations/0001_init.sql'), 'utf8'));
    db.exec(readFileSync(join(REPO_ROOT, 'web/migrations/seed/season-1.sql'), 'utf8'));

    const rows = db
      .prepare('SELECT rio_game_id, sha256, size_raw, size_gz, bytes_gz FROM game_raw')
      .all() as unknown as Row[];

    expect(rows).toHaveLength(14);
    for (const row of rows) {
      expect(String(row.sha256)).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(row.size_gz)).toBeLessThan(Number(row.size_raw));
      // Every stored blob must be under D1's 2 MB per-row ceiling, with room to spare.
      expect(Number(row.size_gz)).toBeLessThan(2_000_000);
    }

    const totalGz = rows.reduce((sum, r) => sum + Number(r.size_gz), 0);
    // A whole season of raw uploads should be a rounding error against the 500 MB cap.
    expect(totalGz).toBeLessThan(1_000_000);
  });
});
