// Shared fixtures for tests that need a SeasonContext built from the Season 1 corpus.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRosterIndex } from '../src/lib/mssb/identify.ts';
import type { SeasonContext } from '../src/lib/mssb/ingest.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export type LegacyTeams = {
  season: { name: string; startDate: string; rounds: number };
  teams: {
    name: string;
    slug: string;
    color: string;
    captainCharId: number;
    captainPortrait: string;
    stadium: string;
    roster: { charId: number; name: string; captain: boolean; portrait: string }[];
  }[];
  schedule: { round: number; matchups: [string, string][] }[];
};

/** Every .json under a directory, recursively, in a stable order. */
export function walkJson(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJson(full));
    else if (name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

export function readLegacyTeams(): LegacyTeams {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'teams.json'), 'utf8')) as LegacyTeams;
}

/**
 * Returns a factory rather than a context: `matchups[].played` is mutated as games claim
 * their rounds, so each test needs its own copy.
 */
export function legacyContext(): () => SeasonContext {
  const legacy = readLegacyTeams();
  const teamIdOf = new Map(legacy.teams.map((t, i) => [t.name, i]));

  return () => ({
    season: {
      slug: 's1',
      name: legacy.season.name,
      shortLabel: 'Season 1 · 2026',
      startDate: legacy.season.startDate,
      rounds: legacy.season.rounds,
    },
    teams: legacy.teams.map((t, i) => ({
      teamId: i,
      slug: t.slug,
      name: t.name,
      stadium: t.stadium,
    })),
    rosterIndex: buildRosterIndex(
      legacy.teams.map((t, i) => ({
        teamId: i,
        slug: t.slug,
        name: t.name,
        charIds: t.roster.map((m) => m.charId),
      })),
    ),
    // teams.json stores each matchup as [away, home] — confirmed against round 1, whose
    // ["Booty Barn","Flame Imp"] is the file booty-barn-vs-flame-imp.
    matchups: legacy.schedule.flatMap((r) =>
      r.matchups.map(([away, home]) => ({
        round: r.round,
        awayTeamId: teamIdOf.get(away)!,
        homeTeamId: teamIdOf.get(home)!,
        played: false,
      })),
    ),
    playedRioIds: new Set<string>(),
  });
}
