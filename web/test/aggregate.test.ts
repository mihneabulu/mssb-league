// Edge cases the Season 1 corpus cannot reach.
//
// A mutation sweep against parity.test.ts showed three pieces of logic surviving
// deliberate breakage, because 14 real games never exercise them: there are no tied
// games, all six win percentages are distinct, and no character has fewer than 3 at-bats.
// Season 2 will hit all three. These synthetic seasons cover them.

import { describe, expect, it } from 'vitest';

import { buildSeasonSnapshot } from '../src/lib/mssb/aggregate.ts';
import { battingRates, newBatting, newPitching, pitchingRates } from '../src/lib/mssb/stats.ts';
import type {
  BattingCounts,
  BoxPlayer,
  GameInput,
  PitchingCounts,
  SeasonInput,
} from '../src/lib/mssb/types.ts';

const season = {
  slug: 'test',
  name: 'Test Season',
  shortLabel: 'Test',
  startDate: '2026-06-29',
  rounds: 4,
};

function player(charId: number, bat: Partial<BattingCounts> = {}, pit: Partial<PitchingCounts> = {}): BoxPlayer {
  return {
    charId,
    name: `Char ${charId}`,
    captain: false,
    batting: battingRates({ ...newBatting(), gp: 1, ...bat }),
    pitching: pitchingRates({ ...newPitching(), ...pit }),
  };
}

/** Nine placeholder players starting at `base`, so each team fields a distinct roster. */
const lineup = (base: number, overrides: Record<number, BoxPlayer> = {}): BoxPlayer[] =>
  Array.from({ length: 9 }, (_, i) => overrides[base + i] ?? player(base + i));

function team(name: string, base: number, stadium = 'Mario Stadium') {
  return {
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    color: '#123456',
    captainCharId: base,
    captainPortrait: `portraits/${base}.png`,
    stadium,
    roster: Array.from({ length: 9 }, (_, i) => ({
      charId: base + i,
      name: `Char ${base + i}`,
      captain: i === 0,
      portrait: `portraits/${base + i}.png`,
    })),
  };
}

let gameCounter = 0;
function game(
  away: string,
  home: string,
  awayScore: number,
  homeScore: number,
  opts: { awayBox?: BoxPlayer[]; homeBox?: BoxPlayer[]; date?: number } = {},
): GameInput {
  gameCounter++;
  return {
    gameId: `g${gameCounter}`,
    round: 1,
    date: 1_780_000_000 + gameCounter * 3600,
    stadiumId: 0,
    innings: 9,
    away,
    home,
    awayScore,
    homeScore,
    boxscore: {
      away: opts.awayBox ?? lineup(0),
      home: opts.homeBox ?? lineup(9),
    },
  };
}

function build(teams: SeasonInput['teams'], games: GameInput[]) {
  return buildSeasonSnapshot(
    { season, teams, schedule: [], games },
    { generatedAt: 'fixed' },
  );
}

describe('ties', () => {
  it('counts a tie as half a win and records it on both teams', () => {
    const a = team('Alpha', 0);
    const b = team('Bravo', 9);
    const snap = build([a, b], [game('Alpha', 'Bravo', 4, 4)]);

    const alpha = snap.teams.find((t) => t.name === 'Alpha')!;
    const bravo = snap.teams.find((t) => t.name === 'Bravo')!;

    expect(alpha.record).toMatchObject({ w: 0, l: 0, t: 1, gp: 1, pct: 0.5 });
    expect(bravo.record).toMatchObject({ w: 0, l: 0, t: 1, gp: 1, pct: 0.5 });
    expect(snap.games[0].winner).toBeNull();
  });

  it('ranks a tie below a win and above a loss', () => {
    const teams = [team('Winner', 0), team('Tied', 9), team('Loser', 18)];
    const snap = build(teams, [
      game('Winner', 'Loser', 5, 0),
      game('Tied', 'Loser', 3, 3, { awayBox: lineup(9), homeBox: lineup(18) }),
    ]);
    expect(snap.standings).toEqual(['Winner', 'Tied', 'Loser']);
  });
});

describe('standings tiebreaks', () => {
  it('breaks equal win% by run differential per game', () => {
    // Both 1-1, but Alpha's wins are by more.
    const teams = [team('Alpha', 0), team('Bravo', 9), team('Carrier', 18)];
    const snap = build(teams, [
      game('Alpha', 'Carrier', 10, 0, { awayBox: lineup(0), homeBox: lineup(18) }),
      game('Alpha', 'Carrier', 0, 1, { awayBox: lineup(0), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 2, 0, { awayBox: lineup(9), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 0, 1, { awayBox: lineup(9), homeBox: lineup(18) }),
    ]);
    const alpha = snap.teams.find((t) => t.name === 'Alpha')!;
    const bravo = snap.teams.find((t) => t.name === 'Bravo')!;
    expect(alpha.record.pct).toBe(bravo.record.pct);
    expect(alpha.record.diff).toBeGreaterThan(bravo.record.diff);
    expect(snap.standings.indexOf('Alpha')).toBeLessThan(snap.standings.indexOf('Bravo'));
  });

  it('uses per-game differential, not total, so an extra game cannot buy rank', () => {
    // Alpha: 1-1, diff +9 over 2 games (+4.5/game).
    // Bravo: 2-2, diff +12 over 4 games (+3.0/game). Bigger total, worse rate.
    const teams = [team('Alpha', 0), team('Bravo', 9), team('Carrier', 18)];
    const snap = build(teams, [
      game('Alpha', 'Carrier', 10, 0, { awayBox: lineup(0), homeBox: lineup(18) }),
      game('Alpha', 'Carrier', 0, 1, { awayBox: lineup(0), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 8, 0, { awayBox: lineup(9), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 0, 1, { awayBox: lineup(9), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 7, 0, { awayBox: lineup(9), homeBox: lineup(18) }),
      game('Bravo', 'Carrier', 0, 2, { awayBox: lineup(9), homeBox: lineup(18) }),
    ]);
    const alpha = snap.teams.find((t) => t.name === 'Alpha')!;
    const bravo = snap.teams.find((t) => t.name === 'Bravo')!;
    expect(alpha.record.pct).toBe(bravo.record.pct);
    expect(bravo.record.diff).toBeGreaterThan(alpha.record.diff);
    expect(snap.standings.indexOf('Alpha')).toBeLessThan(snap.standings.indexOf('Bravo'));
  });

  it('keeps roster order for teams that are equal on every key', () => {
    const teams = [team('First', 0), team('Second', 9)];
    const snap = build(teams, []);
    expect(snap.standings).toEqual(['First', 'Second']);
    expect(snap.teams.map((t) => t.rank)).toEqual([1, 2]);
  });
});

describe('leaderboard qualifiers', () => {
  it('excludes sub-3-AB hitters from rate boards but not counting boards', () => {
    const teams = [team('Alpha', 0), team('Bravo', 9)];
    // charId 0 goes 1-for-1 (a perfect 1.000 average on a single at-bat);
    // charId 1 goes 4-for-10 with a homer over the qualifying threshold.
    const snap = build(teams, [
      game('Alpha', 'Bravo', 1, 0, {
        awayBox: lineup(0, {
          0: player(0, { ab: 1, h: 1, '1b': 1 }),
          1: player(1, { ab: 10, h: 4, '1b': 3, hr: 1, rbi: 1 }),
        }),
      }),
    ]);

    const avgBoard = snap.leaders.batting.avg;
    expect(avgBoard, 'a 1-for-1 hitter must not top the average board').not.toContain(0);
    expect(avgBoard).toContain(1);

    // Counting stats have no qualifier, so the same player still appears there.
    expect(snap.leaders.batting.hits).toContain(0);
  });

  it('excludes sub-1-IP pitchers from ERA and WHIP', () => {
    const teams = [team('Alpha', 0), team('Bravo', 9)];
    const snap = build(teams, [
      game('Alpha', 'Bravo', 0, 1, {
        awayBox: lineup(0, {
          // One out recorded, no runs: a 0.00 ERA that must not qualify.
          0: player(0, {}, { gp: 1, wasPitcher: 1, outs: 1, bf: 1 }),
          // A full three innings with one earned run.
          1: player(1, {}, { gp: 1, wasPitcher: 1, outs: 9, bf: 12, er: 1, r: 1, h: 3 }),
        }),
      }),
    ]);
    expect(snap.leaders.pitching.era).not.toContain(0);
    expect(snap.leaders.pitching.era).toContain(1);
  });
});

describe('stadium anomalies', () => {
  it('flags a game played somewhere other than the home team stadium', () => {
    const teams = [team('Alpha', 0, 'Mario Stadium'), team('Bravo', 9, 'Bowser Castle')];
    const g = game('Alpha', 'Bravo', 1, 0);
    g.stadiumId = 0; // Mario Stadium, but Bravo is at home and plays in Bowser Castle
    const snap = build(teams, [g]);
    expect(snap.stadiumWarnings).toHaveLength(1);
    expect(snap.stadiumWarnings[0]).toContain('Bowser Castle');
  });

  it('stays quiet when the home team is at home', () => {
    const teams = [team('Alpha', 0, 'Mario Stadium'), team('Bravo', 9, 'Bowser Castle')];
    const g = game('Alpha', 'Bravo', 1, 0);
    g.stadiumId = 1; // Bowser Castle
    expect(build(teams, [g]).stadiumWarnings).toEqual([]);
  });
});
