// Loads the Season 1 corpus (repo-root teams.json + results/**/*.json) and turns it into
// a SeasonInput using the SAME code path a browser upload takes. That is the whole point:
// the port is exercised by 14 real games before any of it is deployed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SeasonContext } from '../src/lib/mssb/ingest.ts';
import { analyzeUpload } from '../src/lib/mssb/ingest.ts';
import type { GameInput, SeasonInput, ScheduleRound } from '../src/lib/mssb/types.ts';
import { legacyContext, readLegacyTeams, REPO_ROOT, walkJson } from './legacy-context.ts';

export { REPO_ROOT, readLegacyTeams };

export type LoadedSeason = {
  input: SeasonInput;
  /** One row per game, for the human-reviewed round-assignment table. */
  roundReport: {
    file: string;
    away: string;
    home: string;
    score: string;
    round: number | null;
    warnings: string[];
  }[];
};

/**
 * Build the Season 1 SeasonInput from disk.
 *
 * Rounds are resolved by walking games in chronological order and claiming the earliest
 * unplayed matchup for each pairing — the same greedy pass the frontend used to do at
 * render time, except here it happens once and the answer gets stored.
 */
export function loadLegacySeason(): LoadedSeason {
  const legacy = readLegacyTeams();
  const ctx: SeasonContext = legacyContext()();

  const files = walkJson(join(REPO_ROOT, 'results'));

  // Analyze first so we can order by the actual played date before claiming rounds.
  const analyzed = files
    .map((file) => ({
      file: file.slice(REPO_ROOT.length + 1),
      result: analyzeUpload(readFileSync(file, 'utf8'), file.split('/').pop()!, ctx),
    }))
    .filter((a) => a.result.status !== 'error')
    .sort((a, b) => a.result.playedAt - b.result.playedAt);

  const games: GameInput[] = [];
  const roundReport: LoadedSeason['roundReport'] = [];

  for (const { file, result } of analyzed) {
    if (result.away.name === null || result.home.name === null) {
      throw new Error(`${file}: could not identify both teams`);
    }

    // Re-run the round suggestion now that earlier games have claimed their matchups.
    const round = suggestAndClaim(result.away.teamId!, result.home.teamId!, result.playedAt, ctx);

    ctx.playedRioIds.add(result.rioGameId);

    games.push({
      gameId: result.rioGameId,
      round,
      date: result.playedAt,
      stadiumId: result.stadiumId,
      innings: result.innings,
      away: result.away.name,
      home: result.home.name,
      awayScore: result.awayScore,
      homeScore: result.homeScore,
      boxscore: result.boxscore,
    });

    roundReport.push({
      file,
      away: result.away.name,
      home: result.home.name,
      score: `${result.awayScore}-${result.homeScore}`,
      round,
      warnings: result.warnings.map((w) => w.message),
    });
  }

  const schedule: ScheduleRound[] = legacy.schedule;

  return {
    input: {
      season: ctx.season,
      teams: legacy.teams,
      schedule,
      games,
    },
    roundReport,
  };
}

/** Claim the earliest unplayed scheduled matchup for this pairing. */
function suggestAndClaim(
  awayTeamId: number,
  homeTeamId: number,
  playedAt: number,
  ctx: SeasonContext,
): number | null {
  const match = ctx.matchups
    .filter((m) => !m.played)
    .filter(
      (m) =>
        (m.awayTeamId === awayTeamId && m.homeTeamId === homeTeamId) ||
        (m.awayTeamId === homeTeamId && m.homeTeamId === awayTeamId),
    )
    .sort((a, b) => a.round - b.round)[0];

  if (match) {
    match.played = true;
    return match.round;
  }

  const start = Date.parse(`${ctx.season.startDate}T00:00:00Z`);
  const days = Math.floor((playedAt * 1000 - start) / 86_400_000);
  const bucket = Math.max(1, Math.floor(days / 7) + 1);
  return bucket <= ctx.season.rounds ? bucket : null;
}
