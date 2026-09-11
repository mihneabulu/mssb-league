// The golden diff: the TypeScript port must reproduce, value for value, the data.json
// that build.py produced from the same 14 games. This is the exit criterion for the port
// and stays in CI forever as a regression net on aggregate.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildSeasonSnapshot } from '../src/lib/mssb/aggregate.ts';
import { CHARACTERS } from '../src/lib/mssb/reference.ts';
import { diff, formatDiffs } from './diff.ts';
import { loadLegacySeason, REPO_ROOT } from './legacy.ts';

const golden = JSON.parse(
  readFileSync(join(REPO_ROOT, 'web/test/fixtures/season-1.golden.json'), 'utf8'),
);

/**
 * Differences that are intended, each one a deliberate design change rather than a
 * tolerance. Anything NOT listed here must match exactly.
 *
 *   generatedAt        — injected, so the comparison is deterministic
 *   season.slug/.shortLabel — new fields; the three original fields are still compared
 *   games[].week       — replaced by games[].round (a stored fact, not a folder name)
 *   games[].file       — results/ paths no longer exist
 *   stadiums.note/.names — moved into reference.ts; byId is still compared in full
 *   characterNames     — moved into reference.ts; compared separately below
 */
const { input, roundReport } = loadLegacySeason();
const snapshot = buildSeasonSnapshot(input, {
  includeBoxscores: true,
  generatedAt: golden.generatedAt,
});

describe('Season 1 parity with build.py', () => {
  it('reads the same corpus', () => {
    expect(snapshot.games).toHaveLength(golden.games.length);
    expect(snapshot.teams).toHaveLength(golden.teams.length);
    expect(snapshot.characters).toHaveLength(golden.characters.length);
  });

  it('assigns every game a scheduled round', () => {
    const unassigned = roundReport.filter((r) => r.round === null);
    expect(unassigned, `games with no round: ${JSON.stringify(unassigned, null, 2)}`).toEqual([]);
  });

  it('reproduces the season metadata', () => {
    expect({
      name: snapshot.season.name,
      startDate: snapshot.season.startDate,
      rounds: snapshot.season.rounds,
    }).toEqual(golden.season);
  });

  it('reproduces the character reference table', () => {
    const expected = Object.fromEntries(CHARACTERS.map((n, i) => [String(i), n]));
    expect(expected).toEqual(golden.characterNames);
  });

  it('reproduces the standings, in order', () => {
    expect(snapshot.standings).toEqual(golden.standings);
  });

  it('reproduces every team record, batting and pitching line', () => {
    const diffs = diff(golden.teams, snapshot.teams, 'teams');
    expect(diffs, formatDiffs(diffs)).toEqual([]);
  });

  it('reproduces every character stat line', () => {
    const diffs = diff(golden.characters, snapshot.characters, 'characters');
    expect(diffs, formatDiffs(diffs)).toEqual([]);
  });

  it('reproduces every leaderboard', () => {
    const diffs = diff(golden.leaders, snapshot.leaders, 'leaders');
    expect(diffs, formatDiffs(diffs)).toEqual([]);
  });

  it('reproduces every game and box score', () => {
    // week -> round and the results/ path are the intended changes; everything else
    // about a game, including all 18 box-score lines, must be identical.
    const expected = golden.games.map((g: Record<string, unknown>) => {
      const { week: _week, file: _file, ...rest } = g;
      return rest;
    });
    const actual = snapshot.games.map((g) => {
      const { round: _round, ...rest } = g;
      return rest;
    });
    const diffs = diff(expected, actual, 'games');
    expect(diffs, formatDiffs(diffs)).toEqual([]);
  });

  it('reproduces the schedule', () => {
    expect(snapshot.schedule).toEqual(golden.schedule);
  });

  it('reproduces the learned stadium table, and finds no anomalies', () => {
    expect(snapshot.stadiums.byId).toEqual(golden.stadiums.byId);
    expect(snapshot.stadiumWarnings).toEqual(golden.stadiumConflicts);
  });
});
