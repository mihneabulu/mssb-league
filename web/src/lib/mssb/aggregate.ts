// Season aggregation — the port of build.py.
//
// One pure function: season input in, snapshot out. No I/O, no globals, no Cloudflare
// types, so it runs identically in the Worker, in a Node script, and in vitest. A whole
// season is ~11 KB gzipped, which is why every write can afford to recompute the entire
// thing rather than maintain incremental stats.

import { charName, STADIUMS, stadiumIdByName } from './reference.ts';
import { r3 } from './round.ts';
import {
  addDefense,
  addOffense,
  battingRates,
  newBatting,
  newPitching,
  pitchingRates,
} from './stats.ts';
import type {
  BattingCounts,
  CharAgg,
  Game,
  PitchingCounts,
  SeasonInput,
  SeasonSnapshot,
  Team,
} from './types.ts';

/** Python's datetime.fromtimestamp(ts, tz=UTC).isoformat() — "+00:00", no milliseconds. */
export function isoUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export type BuildOptions = {
  /**
   * Box scores are ~50% of the payload and are only needed on a single game's page, so
   * the snapshot served to public pages leaves them out and /games/:id reads the one row
   * it needs. The parity harness turns them on so the golden diff covers them.
   */
  includeBoxscores?: boolean;
  /** Injectable so tests are deterministic. */
  generatedAt?: string;
};

export function buildSeasonSnapshot(
  input: SeasonInput,
  opts: BuildOptions = {},
): SeasonSnapshot {
  const { includeBoxscores = false, generatedAt = new Date().toISOString() } = opts;

  const teamNames = input.teams.map((t) => t.name);

  const record = new Map(
    teamNames.map((n) => [n, { w: 0, l: 0, t: 0, rf: 0, ra: 0 }]),
  );
  const teamBat = new Map<string, BattingCounts>(teamNames.map((n) => [n, newBatting()]));
  const teamPit = new Map<string, PitchingCounts>(teamNames.map((n) => [n, newPitching()]));

  // Only characters actually involved this season, rather than build.py's hardcoded
  // range(54): a season with a different team count would not exhaust the pool.
  const charBat = new Map<number, BattingCounts>();
  const charPit = new Map<number, PitchingCounts>();
  const charTeam = new Map<number, string>();
  const seenChars = new Set<number>();

  const touch = (charId: number) => {
    if (!charBat.has(charId)) charBat.set(charId, newBatting());
    if (!charPit.has(charId)) charPit.set(charId, newPitching());
    seenChars.add(charId);
  };

  for (const t of input.teams) {
    for (const m of t.roster) {
      charTeam.set(m.charId, t.name);
      touch(m.charId);
    }
  }

  const homeStadium = new Map(input.teams.map((t) => [t.name, t.stadium]));
  const stadiumWarnings: string[] = [];

  const games: Game[] = [];

  // Chronological, as build.py sorted them after collecting.
  const ordered = [...input.games].sort((a, b) => a.date - b.date);

  for (const g of ordered) {
    const rec = { away: record.get(g.away), home: record.get(g.home) };
    if (!rec.away || !rec.home) {
      throw new Error(`game ${g.gameId} references a team outside this season: ${g.away} / ${g.home}`);
    }

    rec.away.rf += g.awayScore;
    rec.away.ra += g.homeScore;
    rec.home.rf += g.homeScore;
    rec.home.ra += g.awayScore;

    let winner: string | null;
    if (g.awayScore > g.homeScore) {
      rec.away.w += 1;
      rec.home.l += 1;
      winner = g.away;
    } else if (g.homeScore > g.awayScore) {
      rec.home.w += 1;
      rec.away.l += 1;
      winner = g.home;
    } else {
      rec.away.t += 1;
      rec.home.t += 1;
      winner = null;
    }

    for (const [side, teamName] of [
      ['away', g.away],
      ['home', g.home],
    ] as const) {
      for (const player of g.boxscore[side]) {
        touch(player.charId);
        // Fold the player's already-derived single-game line back into the running
        // totals. Counting stats are plain sums; rates are recomputed at the end.
        foldBatting(teamBat.get(teamName)!, player.batting);
        foldBatting(charBat.get(player.charId)!, player.batting);
        foldPitching(teamPit.get(teamName)!, player.pitching);
        foldPitching(charPit.get(player.charId)!, player.pitching);
      }
    }

    const expected = homeStadium.get(g.home);
    if (expected !== undefined && stadiumIdByName.get(expected) !== g.stadiumId) {
      stadiumWarnings.push(
        `Game ${g.gameId}: played at ${STADIUMS[g.stadiumId] ?? `stadium ${g.stadiumId}`}, ` +
          `but ${g.home}'s home stadium is ${expected}.`,
      );
    }

    const game: Game = {
      gameId: g.gameId,
      round: g.round,
      date: g.date,
      dateISO: isoUtc(g.date),
      stadiumId: g.stadiumId,
      innings: g.innings,
      away: g.away,
      home: g.home,
      awayScore: g.awayScore,
      homeScore: g.homeScore,
      winner,
    };
    if (includeBoxscores) game.boxscore = g.boxscore;
    games.push(game);
  }

  const gamesPlayed = (n: string) => {
    const r = record.get(n)!;
    return r.w + r.l + r.t;
  };
  const winPct = (n: string) => {
    const r = record.get(n)!;
    const gp = gamesPlayed(n);
    return gp ? (r.w + 0.5 * r.t) / gp : 0;
  };
  const runDiff = (n: string) => {
    const r = record.get(n)!;
    return r.rf - r.ra;
  };

  // Win % (ties count as half a win), then run diff per game, then total run diff — all
  // descending. Percentage and per-game bases keep ranking fair when teams have played
  // different numbers of games. Sort is stable, so teams equal on all three keep their
  // teams.json order, exactly as Python's sorted(reverse=True) did.
  const standings = [...teamNames].sort((a, b) => {
    const keys = (n: string): [number, number, number] => [
      winPct(n),
      gamesPlayed(n) ? runDiff(n) / gamesPlayed(n) : 0,
      runDiff(n),
    ];
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return kb[i] - ka[i];
    }
    return 0;
  });

  const teams: Team[] = input.teams.map((t) => {
    const rec = record.get(t.name)!;
    return {
      ...t,
      record: {
        ...rec,
        gp: gamesPlayed(t.name),
        diff: runDiff(t.name),
        pct: r3(winPct(t.name)),
      },
      batting: battingRates(teamBat.get(t.name)!),
      pitching: pitchingRates(teamPit.get(t.name)!),
      rank: standings.indexOf(t.name) + 1,
    };
  });

  const characters: CharAgg[] = [...seenChars]
    .sort((a, b) => a - b)
    .filter((c) => charBat.get(c)!.gp !== 0 || charPit.get(c)!.gp !== 0)
    .map((c) => ({
      charId: c,
      name: charName(c),
      team: charTeam.get(c) ?? null,
      portrait: `portraits/${c}.png`,
      batting: battingRates(charBat.get(c)!),
      pitching: pitchingRates(charPit.get(c)!),
    }));

  const top = (
    key: (c: CharAgg) => number,
    o: { minAb?: number; minIp?: number; ascending?: boolean } = {},
  ): number[] => {
    let pool = characters;
    if (o.minAb !== undefined) pool = pool.filter((c) => c.batting.ab >= o.minAb!);
    if (o.minIp !== undefined) pool = pool.filter((c) => c.pitching.ip >= o.minIp!);
    const dir = o.ascending ? 1 : -1;
    return [...pool]
      .sort((a, b) => dir * (key(a) - key(b)))
      .slice(0, 10)
      .map((c) => c.charId);
  };

  const leaders = {
    batting: {
      avg: top((c) => c.batting.avg, { minAb: 3 }),
      hr: top((c) => c.batting.hr),
      rbi: top((c) => c.batting.rbi),
      hits: top((c) => c.batting.h),
      ops: top((c) => c.batting.ops, { minAb: 3 }),
      sb: top((c) => c.batting.sb),
    },
    pitching: {
      era: top((c) => c.pitching.era, { minIp: 1, ascending: true }),
      so: top((c) => c.pitching.so),
      whip: top((c) => c.pitching.whip, { minIp: 1, ascending: true }),
      k9: top((c) => c.pitching.k9, { minIp: 1 }),
    },
  };

  return {
    season: input.season,
    generatedAt,
    teams,
    standings,
    games,
    schedule: input.schedule,
    characters,
    leaders,
    stadiums: { byId: Object.fromEntries(Object.entries(STADIUMS)) },
    stadiumWarnings,
  };
}

/** Sum a derived batting line back into an accumulator (counting stats only). */
function foldBatting(acc: BattingCounts, line: BattingCounts): void {
  acc.gp += line.gp;
  acc.ab += line.ab;
  acc.h += line.h;
  acc['1b'] += line['1b'];
  acc['2b'] += line['2b'];
  acc['3b'] += line['3b'];
  acc.hr += line.hr;
  acc.rbi += line.rbi;
  acc.bb += line.bb;
  acc.hbp += line.hbp;
  acc.sf += line.sf;
  acc.so += line.so;
  acc.sb += line.sb;
  acc.starHits += line.starHits;
}

/** Sum a derived pitching line back into an accumulator (counting stats only). */
function foldPitching(acc: PitchingCounts, line: PitchingCounts): void {
  acc.gp += line.gp;
  acc.outs += line.outs;
  acc.bf += line.bf;
  acc.r += line.r;
  acc.er += line.er;
  acc.h += line.h;
  acc.hr += line.hr;
  acc.bb += line.bb;
  acc.hbp += line.hbp;
  acc.so += line.so;
  acc.pitches += line.pitches;
  acc.wasPitcher += line.wasPitcher;
}

export { addDefense, addOffense };
