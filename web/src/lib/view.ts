// The per-request view of one season.
//
// The old data.ts closed over a module-level `import raw from "../data/data.json"`, which
// worked only because there was exactly one season baked into the build. makeView keeps
// every helper's name and behaviour but closes over the snapshot for *this* request
// instead, so pages and components read almost unchanged.

import { charName as refCharName, stadiumName as refStadiumName } from './mssb/reference.ts';
import type { CharAgg, Game, SeasonSnapshot, Team } from './mssb/types.ts';

export type ScheduledMatchup = { away: string; home: string; game?: Game };
export type ScheduledRound = { round: number; matchups: ScheduledMatchup[] };

export type View = ReturnType<typeof makeView>;

/**
 * Bring a stored snapshot up to the current shape.
 *
 * A deploy does not rebuild snapshots — they are rebuilt on the next write — so for a
 * while after this ships every season is still being served from a payload written
 * before characters had a `key` and before leaderboards held keys instead of character
 * ids. Both are the same thing in a season without duplicates, so the upgrade is exact,
 * and it disappears the moment the season is next edited.
 */
function upgrade(snapshot: SeasonSnapshot): SeasonSnapshot {
  const stale =
    snapshot.season.allowDuplicateChars === undefined ||
    snapshot.characters.some((c) => c.key === undefined) ||
    Object.values(snapshot.leaders.batting).some((ids) => ids.some((v) => typeof v !== 'string'));
  if (!stale) return snapshot;

  const keys = (board: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(Object.entries(board).map(([k, ids]) => [k, ids.map(String)]));

  return {
    ...snapshot,
    season: { ...snapshot.season, allowDuplicateChars: snapshot.season.allowDuplicateChars ?? false },
    characters: snapshot.characters.map((c) => ({ ...c, key: c.key ?? String(c.charId) })),
    leaders: {
      batting: keys(snapshot.leaders.batting),
      pitching: keys(snapshot.leaders.pitching),
    },
  };
}

export function makeView(stored: SeasonSnapshot) {
  const snapshot = upgrade(stored);
  const byName = new Map(snapshot.teams.map((t) => [t.name, t]));
  const bySlug = new Map(snapshot.teams.map((t) => [t.slug, t]));
  const byGameId = new Map(snapshot.games.map((g) => [g.gameId, g]));

  const team = (name: string): Team | undefined => byName.get(name);
  const teamBySlug = (slug: string): Team | undefined => bySlug.get(slug);

  /**
   * Schedule with results attached.
   *
   * The old implementation guessed: it walked the rounds and greedily claimed the
   * earliest unused game whose two teams matched. Now every game carries the round a
   * human confirmed at upload time, so this is a lookup rather than an inference.
   */
  function scheduleWithResults(): {
    rounds: ScheduledRound[];
    currentRound: number;
    complete: boolean;
  } {
    const byRound = new Map<number, Game[]>();
    for (const g of snapshot.games) {
      if (g.round === null) continue;
      const list = byRound.get(g.round);
      if (list) list.push(g);
      else byRound.set(g.round, [g]);
    }

    const rounds: ScheduledRound[] = snapshot.schedule.map((rd) => {
      const pool = [...(byRound.get(rd.round) ?? [])];
      return {
        round: rd.round,
        matchups: rd.matchups.map(([away, home]) => {
          const i = pool.findIndex(
            (g) =>
              (g.away === away && g.home === home) || (g.away === home && g.home === away),
          );
          const game = i >= 0 ? pool.splice(i, 1)[0] : undefined;
          return { away, home, game };
        }),
      };
    });

    const firstIncomplete = rounds.find((r) => r.matchups.some((m) => !m.game));
    const complete = !firstIncomplete && rounds.length > 0;
    const currentRound = firstIncomplete?.round ?? rounds.at(-1)?.round ?? 1;
    return { rounds, currentRound, complete };
  }

  return {
    data: snapshot,
    season: snapshot.season,
    team,
    teamBySlug,
    game: (gameId: string): Game | undefined => byGameId.get(gameId),
    charName: refCharName,
    stadiumName: refStadiumName,
    homeStadium: (teamName: string): string => team(teamName)?.stadium ?? '',
    standingsTeams: (): Team[] =>
      snapshot.standings.map((n) => byName.get(n)).filter((t): t is Team => t !== undefined),
    teamGames: (name: string): Game[] =>
      snapshot.games.filter((g) => g.away === name || g.home === name),
    teamCharacters: (t: Team): CharAgg[] => {
      // With duplicates allowed every stat line already belongs to exactly one team,
      // including a substitute's, so the team itself is the filter. Without them a line
      // is per character and the roster is what says whose it is.
      if (snapshot.season.allowDuplicateChars) {
        return snapshot.characters.filter((c) => c.team === t.name);
      }
      const ids = new Set(t.roster.map((m) => m.charId));
      return snapshot.characters.filter((c) => ids.has(c.charId));
    },
    scheduleWithResults,
    /** The most recent round with any played game — used for "latest results". */
    latestRound: (): number | null => {
      const played = snapshot.games.filter((g) => g.round !== null);
      return played.length ? Math.max(...played.map((g) => g.round!)) : null;
    },
  };
}
