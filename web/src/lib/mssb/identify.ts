// Which team is this? Every Project Rio game logs both managers as the same account,
// so a side is identified by its drafted roster: the exact set of 9 character ids.
//
// A season that allows duplicates makes rosters overlap on purpose, which weakens this
// considerably — two teams can share eight of nine characters. The matching itself is
// unchanged; what changes is how much the upload review trusts a non-exact result (see
// ingest.ts).
//
// Ported from ingest.py's identify(), with three deliberate changes for the browser
// flow. The CLI could get away with a confident wrong guess because a human was reading
// stdout and could re-run; a web upload needs the parser to be able to say "I don't
// know, you pick" and have that correction recorded.

import { ROSTER_SIZE } from './rio.ts';

export type IndexedTeam = {
  teamId: number;
  slug: string;
  name: string;
  charIds: Set<number>;
};

export type RosterIndex = { teams: IndexedTeam[] };

export type SideMatch = {
  teamId: number | null;
  slug: string | null;
  name: string | null;
  /** True only for an exact set match on all 9 characters. */
  exact: boolean;
  /** How many of the 9 characters matched the chosen team. */
  overlap: number;
  /** Two or more teams tied on overlap — the pick is a coin flip. */
  ambiguous: boolean;
};

/**
 * Below this many matching characters out of 9, we refuse to guess. ingest.py always
 * returned its best team no matter how bad the overlap; with a fresh draft each season
 * that could silently attribute a game to a team that shares two characters by chance.
 */
export const MIN_OVERLAP = 5;

export function buildRosterIndex(
  teams: { teamId: number; slug: string; name: string; charIds: Iterable<number> }[],
): RosterIndex {
  return {
    teams: teams.map((t) => ({
      teamId: t.teamId,
      slug: t.slug,
      name: t.name,
      charIds: new Set(t.charIds),
    })),
  };
}

const noMatch = (overlap = 0, ambiguous = false): SideMatch => ({
  teamId: null,
  slug: null,
  name: null,
  exact: false,
  overlap,
  ambiguous,
});

/** Identify one side from its nine character ids. */
export function identifySide(charIds: number[], index: RosterIndex): SideMatch {
  const ids = new Set(charIds);

  let best: IndexedTeam | null = null;
  let bestOverlap = -1;
  let atBest = 0;

  for (const team of index.teams) {
    let overlap = 0;
    for (const id of ids) if (team.charIds.has(id)) overlap++;

    if (overlap > bestOverlap) {
      best = team;
      bestOverlap = overlap;
      atBest = 1;
    } else if (overlap === bestOverlap) {
      atBest++;
    }
  }

  // Counted rather than flagged: when a season allows duplicates two teams can match the
  // same nine ids equally well — even perfectly, if they drafted the same roster — and a
  // boolean that excused itself for exact matches would have picked one at random.
  const tied = atBest > 1;

  if (!best || bestOverlap < MIN_OVERLAP) return noMatch(Math.max(bestOverlap, 0), tied);

  // An exact match means the drafted set, not merely 9 overlapping ids.
  const exact =
    bestOverlap === ROSTER_SIZE && ids.size === ROSTER_SIZE && best.charIds.size === ROSTER_SIZE;

  return {
    teamId: best.teamId,
    slug: best.slug,
    name: best.name,
    exact,
    overlap: bestOverlap,
    ambiguous: tied,
  };
}

export type GameIdentification = {
  away: SideMatch;
  home: SideMatch;
  /** Both sides resolved to the same team — impossible, so the weaker one is dropped. */
  collision: boolean;
};

/**
 * Identify both sides at once. A team cannot play itself, so if both sides land on the
 * same team the lower-confidence side is demoted to "unknown" and flagged for review
 * rather than silently producing a game a team played against itself.
 */
export function identifyGame(
  awayCharIds: number[],
  homeCharIds: number[],
  index: RosterIndex,
): GameIdentification {
  const away = identifySide(awayCharIds, index);
  const home = identifySide(homeCharIds, index);

  if (away.teamId !== null && away.teamId === home.teamId) {
    const awayWins = away.exact !== home.exact ? away.exact : away.overlap >= home.overlap;
    return awayWins
      ? { away, home: noMatch(home.overlap), collision: true }
      : { away: noMatch(away.overlap), home, collision: true };
  }

  return { away, home, collision: false };
}
