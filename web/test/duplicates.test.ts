// Seasons that let the same character play for more than one team.
//
// Season 1 drafted from an exclusive pool and the whole stack assumed it: the roster
// table's primary key, the aggregation's one-bucket-per-charId, the leaderboards' lists
// of character ids, the draft board's disabled cells. This covers the other setting —
// and, just as importantly, that turning it off leaves all of that exactly as it was.

import { describe, expect, it } from 'vitest';

import { InputError } from '../src/lib/admin/respond.ts';
import { saveRoster, setDuplicateChars } from '../src/lib/db/admin.ts';
import { loadSeasonInput } from '../src/lib/db/queries.ts';
import type { Executable } from '../src/lib/db/queries.ts';
import { buildSeasonSnapshot, characterKey } from '../src/lib/mssb/aggregate.ts';
import { buildRosterIndex, identifySide } from '../src/lib/mssb/identify.ts';
import { battingRates, newBatting, newPitching, pitchingRates } from '../src/lib/mssb/stats.ts';
import type {
  BattingCounts,
  BoxPlayer,
  GameInput,
  SeasonInput,
} from '../src/lib/mssb/types.ts';
import { makeView } from '../src/lib/view.ts';
import { executable, migrated } from './sqlite.ts';

// --- fixtures ------------------------------------------------------------------------

const player = (charId: number, bat: Partial<BattingCounts> = {}): BoxPlayer => ({
  charId,
  name: `Char ${charId}`,
  captain: false,
  batting: battingRates({ ...newBatting(), gp: 1, ...bat }),
  pitching: pitchingRates(newPitching()),
});

/** Nine players: `shared` in the leadoff slot, then eight ids of the team's own. */
const lineup = (shared: number, base: number, bat: Partial<BattingCounts> = {}): BoxPlayer[] => [
  player(shared, bat),
  ...Array.from({ length: 8 }, (_, i) => player(base + i)),
];

function team(name: string, shared: number, base: number): SeasonInput['teams'][number] {
  const charIds = [shared, ...Array.from({ length: 8 }, (_, i) => base + i)];
  return {
    name,
    slug: name.toLowerCase(),
    color: '#123456',
    captainCharId: charIds[1],
    captainPortrait: `portraits/${charIds[1]}.png`,
    stadium: 'Mario Stadium',
    roster: charIds.map((charId, i) => ({
      charId,
      name: `Char ${charId}`,
      captain: i === 1,
      portrait: `portraits/${charId}.png`,
    })),
  };
}

// Both teams drafted character 5. Alpha's Mario goes 3-for-4; Bravo's goes 0-for-4.
const SHARED = 5;
const alpha = team('Alpha', SHARED, 10);
const bravo = team('Bravo', SHARED, 30);

const theGame: GameInput = {
  gameId: 'g1',
  round: 1,
  date: 1_780_000_000,
  stadiumId: 0,
  innings: 9,
  away: 'Alpha',
  home: 'Bravo',
  awayScore: 3,
  homeScore: 0,
  boxscore: {
    away: lineup(SHARED, 10, { ab: 4, h: 3, '1b': 3, rbi: 3 }),
    home: lineup(SHARED, 30, { ab: 4, h: 0 }),
  },
};

const build = (allowDuplicateChars: boolean) =>
  buildSeasonSnapshot(
    {
      season: {
        slug: 'test',
        name: 'Test Season',
        shortLabel: 'Test',
        startDate: '2026-06-29',
        rounds: 4,
        allowDuplicateChars,
      },
      teams: [alpha, bravo],
      schedule: [],
      games: [theGame],
    },
    { generatedAt: 'fixed' },
  );

// --- aggregation ---------------------------------------------------------------------

describe('a season that allows duplicates', () => {
  it('gives each team its own stat line for a shared character', () => {
    const snap = build(true);
    const lines = snap.characters.filter((c) => c.charId === SHARED);

    expect(lines.map((c) => c.key)).toEqual(['alpha:5', 'bravo:5']);
    expect(lines.map((c) => c.team)).toEqual(['Alpha', 'Bravo']);
    expect(lines.map((c) => c.batting.h)).toEqual([3, 0]);
    expect(lines.map((c) => c.batting.avg)).toEqual([0.75, 0]);
  });

  it('puts both copies on the leaderboards, ranked on their own numbers', () => {
    const board = build(true).leaders.batting.hits;
    expect(board.indexOf('alpha:5')).toBeLessThan(board.indexOf('bravo:5'));
  });

  it('gives each team page only its own copy', () => {
    const snap = build(true);
    const view = makeView(snap);
    const alphaTeam = view.teamBySlug('alpha')!;

    const shared = view.teamCharacters(alphaTeam).filter((c) => c.charId === SHARED);
    expect(shared.map((c) => c.key)).toEqual(['alpha:5']);
    expect(shared[0].batting.h).toBe(3);
  });

  it('keeps a character who played for a team but was never drafted by it', () => {
    // A substitute: charId 50 appears in Alpha's box score and on nobody's roster.
    const withSub: GameInput = {
      ...theGame,
      boxscore: {
        ...theGame.boxscore,
        away: [player(50, { ab: 2, h: 2, '1b': 2 }), ...theGame.boxscore.away.slice(1)],
      },
    };
    const snap = buildSeasonSnapshot(
      {
        season: { ...build(true).season },
        teams: [alpha, bravo],
        schedule: [],
        games: [withSub],
      },
      { generatedAt: 'fixed' },
    );
    const sub = snap.characters.find((c) => c.charId === 50)!;
    expect(sub.key).toBe('alpha:50');
    expect(sub.team).toBe('Alpha');
    // And the team page finds them, which filtering by the roster would not.
    expect(makeView(snap).teamCharacters(makeView(snap).teamBySlug('alpha')!)).toContainEqual(sub);
  });
});

describe('a season that does not', () => {
  it('merges a shared character into one line, as it always did', () => {
    const snap = build(false);
    const lines = snap.characters.filter((c) => c.charId === SHARED);

    expect(lines.map((c) => c.key)).toEqual(['5']);
    expect(lines[0].batting.h).toBe(3);
    expect(lines[0].batting.ab).toBe(8);
  });

  it('keys every line by the plain character id', () => {
    const snap = build(false);
    expect(snap.characters.every((c) => c.key === String(c.charId))).toBe(true);
    expect(snap.leaders.batting.hits.every((k) => /^\d+$/.test(k))).toBe(true);
  });
});

describe('characterKey', () => {
  it('ignores the team unless the season allows duplicates', () => {
    expect(characterKey(5, 'alpha', false)).toBe('5');
    expect(characterKey(5, 'alpha', true)).toBe('alpha:5');
    // Nobody's team, so nothing to qualify it with.
    expect(characterKey(5, null, true)).toBe('5');
  });
});

// --- reading a snapshot written before any of this existed ---------------------------

describe('a snapshot stored by the previous version', () => {
  it('is read as though it had keys', () => {
    const snap = build(false);
    // What a payload written before this change looks like: no key, numeric boards.
    const stored = JSON.parse(JSON.stringify(snap));
    for (const c of stored.characters) delete c.key;
    stored.leaders.batting.hits = stored.leaders.batting.hits.map(Number);
    delete stored.season.allowDuplicateChars;

    const view = makeView(stored);
    const line = view.data.characters.find((c) => c.charId === SHARED)!;
    expect(line.key).toBe('5');
    expect(view.data.leaders.batting.hits).toContain('5');
    expect(view.data.season.allowDuplicateChars).toBe(false);
  });
});

// --- identification ------------------------------------------------------------------

describe('identifying a side when rosters overlap', () => {
  const index = buildRosterIndex([
    { teamId: 1, slug: 'alpha', name: 'Alpha', charIds: alpha.roster.map((m) => m.charId) },
    { teamId: 2, slug: 'bravo', name: 'Bravo', charIds: bravo.roster.map((m) => m.charId) },
  ]);

  it('still matches the exact drafted nine', () => {
    const match = identifySide(alpha.roster.map((m) => m.charId), index);
    expect(match).toMatchObject({ teamId: 1, exact: true, overlap: 9, ambiguous: false });
  });

  it('flags a tie rather than picking one of two equally good teams', () => {
    // Two teams with identical rosters: possible only once duplicates are allowed.
    const twins = buildRosterIndex([
      { teamId: 1, slug: 'alpha', name: 'Alpha', charIds: alpha.roster.map((m) => m.charId) },
      { teamId: 2, slug: 'copy', name: 'Copy', charIds: alpha.roster.map((m) => m.charId) },
    ]);
    const match = identifySide(alpha.roster.map((m) => m.charId), twins);
    expect(match.exact).toBe(true);
    expect(match.ambiguous, 'an exact match to two teams is still a coin flip').toBe(true);
  });
});

// --- the database --------------------------------------------------------------------

async function seedSeason(db: Executable): Promise<{ seasonId: number; teams: number[] }> {
  const seasonId = await db.insert(
    `INSERT INTO seasons (slug, name, short_label, start_date, rounds, status, is_current, created_at, updated_at)
     VALUES ('s9', 'Season 9', 'S9', '2027-06-01', 4, 'draft', 0, 0, 0)`,
  );
  const teams: number[] = [];
  for (const name of ['Alpha', 'Bravo']) {
    teams.push(
      await db.insert(
        `INSERT INTO teams (season_id, slug, name, color, stadium_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, '#123456', 0, ?, 0, 0)`,
        [seasonId, name.toLowerCase(), name, teams.length],
      ),
    );
  }
  return { seasonId, teams };
}

const nine = (base: number) => Array.from({ length: 9 }, (_, i) => base + i);

describe('the roster table', () => {
  it('refuses a second team the same character while the season is exclusive', async () => {
    const db = executable(migrated());
    const { seasonId, teams } = await seedSeason(db);

    await saveRoster(db, seasonId, teams[0], nine(0), 0);
    await expect(saveRoster(db, seasonId, teams[1], [0, ...nine(20).slice(0, 8)], null)).rejects
      .toThrow(/Already drafted by Alpha/);
  });

  it('allows it once the season does, and keeps each line separate', async () => {
    const db = executable(migrated());
    const { seasonId, teams } = await seedSeason(db);

    await saveRoster(db, seasonId, teams[0], nine(0), 0);
    await setDuplicateChars(db, seasonId, true);
    await saveRoster(db, seasonId, teams[1], [0, ...nine(20).slice(0, 8)], 0);

    const input = (await loadSeasonInput(db, 's9'))!;
    expect(input.season.allowDuplicateChars).toBe(true);
    expect(input.teams.map((t) => t.roster.some((m) => m.charId === 0))).toEqual([true, true]);
  });

  it('still refuses to put the same character on one team twice', async () => {
    const db = executable(migrated());
    const { seasonId, teams } = await seedSeason(db);
    await setDuplicateChars(db, seasonId, true);

    await expect(saveRoster(db, seasonId, teams[0], [0, 0, ...nine(20).slice(0, 7)], null)).rejects
      .toThrow(/selected twice/);
  });

  it('will not switch back to exclusive while a character is shared', async () => {
    const db = executable(migrated());
    const { seasonId, teams } = await seedSeason(db);

    await setDuplicateChars(db, seasonId, true);
    await saveRoster(db, seasonId, teams[0], nine(0), null);
    await saveRoster(db, seasonId, teams[1], [0, ...nine(20).slice(0, 8)], null);

    // The message has to name the character, because "constraint failed" does not tell
    // anyone which pick to undo.
    await expect(setDuplicateChars(db, seasonId, false)).rejects.toThrow(/Mario \(Alpha, Bravo\)/);
    await expect(setDuplicateChars(db, seasonId, false)).rejects.toThrow(InputError);
  });

  it('switches back once the shared pick is gone, and re-locks the pool', async () => {
    const db = executable(migrated());
    const { seasonId, teams } = await seedSeason(db);

    await setDuplicateChars(db, seasonId, true);
    await saveRoster(db, seasonId, teams[0], nine(0), null);
    await saveRoster(db, seasonId, teams[1], [0, ...nine(20).slice(0, 8)], null);

    await saveRoster(db, seasonId, teams[1], nine(20), null);
    await setDuplicateChars(db, seasonId, false);

    const scopes = await db.all(`SELECT DISTINCT dup_scope FROM roster_slots WHERE season_id = ?`, [
      seasonId,
    ]);
    expect(scopes.map((r) => Number(r.dup_scope))).toEqual([0]);
    await expect(saveRoster(db, seasonId, teams[1], [0, ...nine(20).slice(0, 8)], null)).rejects
      .toThrow(/Already drafted by Alpha/);
  });
});
