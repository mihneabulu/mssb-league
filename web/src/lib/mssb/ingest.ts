// Turning an uploaded Project Rio file into a reviewable game — the port of ingest.py's
// decision-making, with every filesystem concern removed.
//
// The CLI moved files into results/week-NN/ and printed its guesses to stdout for a human
// to sanity-check. Here the same guesses become structured suggestions plus warnings that
// a human confirms or corrects in the browser, and the correction is then *stored* rather
// than requiring a --week flag and a re-run.

import { normalizeDecoded, resolveDecodedSide } from './decoded.ts';
import type { RosterIndex, SideMatch } from './identify.ts';
import { identifyGame } from './identify.ts';
import { charName, STADIUMS, stadiumIdByName } from './reference.ts';
import type { RioGame, Side } from './rio.ts';
import {
  isDecodedExport,
  parseRioFile,
  ROSTER_SIZE,
  rosterCharValues,
  rosterEntry,
  stripEvents,
} from './rio.ts';
import { battingFor, pitchingFor } from './stats.ts';
import type { BoxPlayer, SeasonMeta } from './types.ts';

export type ContextTeam = {
  teamId: number;
  slug: string;
  name: string;
  /** Home stadium name; used to flag a game played somewhere unexpected. */
  stadium: string | null;
};

export type ContextMatchup = {
  round: number;
  awayTeamId: number;
  homeTeamId: number;
  /** True once a game has been recorded against this matchup. */
  played: boolean;
};

export type SeasonContext = {
  season: SeasonMeta;
  teams: ContextTeam[];
  rosterIndex: RosterIndex;
  matchups: ContextMatchup[];
  /** Rio game ids already recorded this season, for duplicate detection. */
  playedRioIds: Set<string>;
};

export type AnalysisWarning =
  | { kind: 'decoded'; message: string }
  | { kind: 'fuzzy-roster'; message: string }
  | { kind: 'unknown-team'; message: string }
  | { kind: 'team-collision'; message: string }
  | { kind: 'ambiguous-roster'; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'stadium'; message: string }
  | { kind: 'no-round'; message: string }
  | { kind: 'elimination'; message: string };

export type AnalyzedGame = {
  status: 'ok' | 'needs_review' | 'duplicate' | 'error';
  filename: string;
  error?: string;
  rioGameId: string;
  playedAt: number;
  endedAt: number | null;
  stadiumId: number;
  innings: number;
  awayScore: number;
  homeScore: number;
  away: SideMatch;
  home: SideMatch;
  suggestedRound: number | null;
  wasDecoded: boolean;
  warnings: AnalysisWarning[];
  boxscore: { away: BoxPlayer[]; home: BoxPlayer[] };
  /** The game with Events removed and decoded fields normalized. */
  normalized: RioGame;
};

/** Pull the box score for one game: nine players a side, each with a one-game line. */
export function extractBoxScore(game: RioGame): { away: BoxPlayer[]; home: BoxPlayer[] } {
  const read = (side: Side): BoxPlayer[] => {
    const players: BoxPlayer[] = [];
    for (let slot = 0; slot < ROSTER_SIZE; slot++) {
      const entry = rosterEntry(game, side, slot);
      const charId = Number(entry.CharID);
      players.push({
        charId,
        name: charName(charId),
        captain: Boolean(entry.Captain),
        batting: battingFor(entry['Offensive Stats']),
        pitching: pitchingFor(entry['Defensive Stats']),
      });
    }
    return players;
  };
  return { away: read('Away'), home: read('Home') };
}

/**
 * Which round does this game belong to?
 *
 * This is where ingest.py's week_for() and the frontend's render-time greedy matcher
 * merge and die. Prefer the earliest scheduled round where this exact pairing has not
 * been played yet; fall back to the calendar bucket the CLI used; otherwise admit defeat
 * and let the human choose.
 */
export function suggestRound(
  awayTeamId: number | null,
  homeTeamId: number | null,
  playedAt: number,
  ctx: SeasonContext,
): number | null {
  if (awayTeamId !== null && homeTeamId !== null) {
    const candidates = ctx.matchups
      .filter((m) => !m.played)
      .filter(
        (m) =>
          (m.awayTeamId === awayTeamId && m.homeTeamId === homeTeamId) ||
          (m.awayTeamId === homeTeamId && m.homeTeamId === awayTeamId),
      )
      .sort((a, b) => a.round - b.round);
    if (candidates.length) return candidates[0].round;
  }

  const start = Date.parse(`${ctx.season.startDate}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const days = Math.floor((playedAt * 1000 - start) / 86_400_000);
  const bucket = Math.max(1, Math.floor(days / 7) + 1);
  return bucket <= ctx.season.rounds ? bucket : null;
}

/** Rio names files `<timestamp>_<away>-vs-<home>_<gameId>.json`. */
const FILENAME_RE = /^(?:decoded\.)?(?<ts>\d{8}T\d{6})_.*_(?<gid>\d+)\.json$/;

function rioGameIdOf(game: RioGame, filename: string): string {
  const m = FILENAME_RE.exec(filename);
  if (m?.groups?.gid) return m.groups.gid;
  if (game.GameID !== undefined && game.GameID !== null) return String(game.GameID);
  return 'unknown';
}

/** Analyze one uploaded file against a season. Never throws on bad input. */
export function analyzeUpload(
  fileText: string,
  filename: string,
  ctx: SeasonContext,
): AnalyzedGame {
  const parsed = parseRioFile(fileText);
  if (!parsed.ok) return errorResult(filename, parsed.error);

  try {
    return analyze(parsed.game, filename, ctx);
  } catch (e) {
    return errorResult(filename, (e as Error).message);
  }
}

function analyze(raw: RioGame, filename: string, ctx: SeasonContext): AnalyzedGame {
  const warnings: AnalysisWarning[] = [];
  const wasDecoded = isDecodedExport(raw);

  let game = stripEvents(raw);
  let away: SideMatch;
  let home: SideMatch;

  if (wasDecoded) {
    warnings.push({
      kind: 'decoded',
      message: ctx.season.allowDuplicateChars
        ? 'Decoded export — converted back to the raw numeric format. This season allows ' +
          'the same character on several teams, and a decoded file names characters ' +
          'instead of numbering them, so check both sides are the right teams.'
        : 'Decoded export — converted back to the raw numeric format.',
    });

    const awaySide = resolveDecodedSide(
      rosterCharValues(game, 'Away').map(String),
      ctx.rosterIndex,
    );
    const homeSide = resolveDecodedSide(
      rosterCharValues(game, 'Home').map(String),
      ctx.rosterIndex,
    );
    for (const note of [...awaySide.notes, ...homeSide.notes]) {
      warnings.push({ kind: 'elimination', message: note });
    }

    game = normalizeDecoded(game, { Away: awaySide.charIds, Home: homeSide.charIds }).game;

    // Re-identify from the now-numeric ids so both paths share one code path.
    const ident = identifyGame(
      rosterCharValues(game, 'Away').map(Number),
      rosterCharValues(game, 'Home').map(Number),
      ctx.rosterIndex,
    );
    away = ident.away;
    home = ident.home;
    if (ident.collision) {
      warnings.push({
        kind: 'team-collision',
        message: 'Both sides matched the same team — pick the teams manually.',
      });
    }
  } else {
    const ident = identifyGame(
      rosterCharValues(game, 'Away').map(Number),
      rosterCharValues(game, 'Home').map(Number),
      ctx.rosterIndex,
    );
    away = ident.away;
    home = ident.home;
    if (ident.collision) {
      warnings.push({
        kind: 'team-collision',
        message: 'Both sides matched the same team — pick the teams manually.',
      });
    }
  }

  for (const [label, side] of [
    ['Away', away],
    ['Home', home],
  ] as const) {
    if (side.teamId === null) {
      warnings.push({
        kind: 'unknown-team',
        message: `${label} roster matched no team (best overlap ${side.overlap}/${ROSTER_SIZE}) — pick it manually.`,
      });
    } else if (!side.exact) {
      warnings.push({
        kind: 'fuzzy-roster',
        message: `${label} matched ${side.name} on ${side.overlap}/${ROSTER_SIZE} characters, not an exact roster — a substitute may have played.`,
      });
    }
    if (side.ambiguous) {
      warnings.push({
        kind: 'ambiguous-roster',
        message: `${label} roster matched more than one team equally well — confirm the team.`,
      });
    }
  }

  const rioGameId = rioGameIdOf(game, filename);
  if (ctx.playedRioIds.has(rioGameId)) {
    warnings.push({
      kind: 'duplicate',
      message: `Game ${rioGameId} is already recorded for this season.`,
    });
  }

  const playedAt = Number(game['Date - Start']);
  const endedRaw = Number(game['Date - End']);
  const stadiumId = Number(game.StadiumID);

  const homeTeam = ctx.teams.find((t) => t.teamId === home.teamId);
  if (homeTeam?.stadium && stadiumIdByName.get(homeTeam.stadium) !== stadiumId) {
    warnings.push({
      kind: 'stadium',
      message: `Played at ${STADIUMS[stadiumId] ?? `stadium ${stadiumId}`}, but ${homeTeam.name}'s home stadium is ${homeTeam.stadium}.`,
    });
  }

  const suggestedRound = suggestRound(away.teamId, home.teamId, playedAt, ctx);
  if (suggestedRound === null) {
    warnings.push({
      kind: 'no-round',
      message: 'No scheduled round matches this pairing — choose one.',
    });
  }

  // 'elimination' is blocking on purpose. A decoded export identifies players only by
  // name, resolved against the drafted roster, so when a name does not map cleanly the
  // most likely cause is a substitute — and the substitute is silently replaced by the
  // drafted player, producing an exact-looking roster match. ingest.py printed a note
  // and moved on; here it forces a human to look.
  const kinds = ['unknown-team', 'team-collision', 'ambiguous-roster', 'no-round', 'elimination'];

  // Identification is overlap against the drafted nine, and a season that allows
  // duplicates deliberately makes rosters overlap: 8/9 might be a substitute, or might
  // be the other team that drafted nearly the same players. Only an exact set is
  // trusted, and a decoded export — which resolves names against a single team's roster
  // and so cannot tell those two apart at all — is never trusted on its own.
  if (ctx.season.allowDuplicateChars) kinds.push('fuzzy-roster', 'decoded');

  const blocking = warnings.some((w) => kinds.includes(w.kind));
  const duplicate = warnings.some((w) => w.kind === 'duplicate');

  return {
    status: duplicate ? 'duplicate' : blocking ? 'needs_review' : 'ok',
    filename,
    rioGameId,
    playedAt,
    endedAt: Number.isFinite(endedRaw) ? endedRaw : null,
    stadiumId,
    innings: game['Innings Played'],
    awayScore: game['Away Score'],
    homeScore: game['Home Score'],
    away,
    home,
    suggestedRound,
    wasDecoded,
    warnings,
    boxscore: extractBoxScore(game),
    normalized: game,
  };
}

function errorResult(filename: string, error: string): AnalyzedGame {
  return {
    status: 'error',
    filename,
    error,
    rioGameId: 'unknown',
    playedAt: 0,
    endedAt: null,
    stadiumId: -1,
    innings: 0,
    awayScore: 0,
    homeScore: 0,
    away: { teamId: null, slug: null, name: null, exact: false, overlap: 0, ambiguous: false },
    home: { teamId: null, slug: null, name: null, exact: false, overlap: 0, ambiguous: false },
    suggestedRound: null,
    wasDecoded: false,
    warnings: [],
    boxscore: { away: [], home: [] },
    normalized: {} as RioGame,
  };
}
