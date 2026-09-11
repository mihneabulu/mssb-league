// Reading a season back out of the database.
//
// Deliberately driver-agnostic: the Worker passes a D1 binding, the round-trip test
// passes a node:sqlite database. Both go through the same SQL and the same row mapping,
// so the test actually covers the code that runs in production — including the awkward
// parts, like SQLite handing back 0/1 where the domain wants true/false.

import { charName, stadiumName } from '../mssb/reference.ts';
import type { BoxPlayer, ScheduleRound, SeasonInput } from '../mssb/types.ts';

export type Row = Record<string, unknown>;

/** The single capability the read path needs from a database driver. */
export interface Queryable {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
}

export type Statement = { sql: string; params?: unknown[] };

/** Reads plus writes, for the admin path and snapshot rebuilds. */
export interface Executable extends Queryable {
  run(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Apply several statements as one unit. D1 allows 50 queries per Worker invocation,
   * so anything touching many rows must batch rather than loop.
   */
  batch(statements: Statement[]): Promise<void>;
  /** Insert and return the new rowid, which D1 does not give back from run(). */
  insert(sql: string, params?: unknown[]): Promise<number>;
}

export const SQL = {
  season: `SELECT id, slug, name, short_label, start_date, rounds, status, is_current
           FROM seasons WHERE slug = ?`,
  currentSeason: `SELECT id, slug, name, short_label, start_date, rounds, status, is_current
                  FROM seasons WHERE is_current = 1`,
  seasonList: `SELECT slug, short_label, status, is_current FROM seasons
               ORDER BY start_date DESC, id DESC`,
  teams: `SELECT id, slug, name, color, captain_char_id, stadium_id
          FROM teams WHERE season_id = ? ORDER BY sort_order, id`,
  roster: `SELECT team_id, char_id, is_captain FROM roster_slots
           WHERE season_id = ? ORDER BY team_id, char_id`,
  rounds: `SELECT id, round_no, label FROM rounds WHERE season_id = ? ORDER BY round_no`,
  matchups: `SELECT round_id, slot, away_team_id, home_team_id FROM matchups
             WHERE season_id = ? ORDER BY round_id, slot`,
  games: `SELECT g.rio_game_id, g.played_at, g.stadium_id, g.innings_played,
                 g.away_score, g.home_score, g.box_json,
                 r.round_no AS round_no,
                 a.name AS away_name, h.name AS home_name
          FROM games g
          JOIN teams a ON a.id = g.away_team_id
          JOIN teams h ON h.id = g.home_team_id
          LEFT JOIN rounds r ON r.id = g.round_id
          WHERE g.season_id = ?
          ORDER BY g.played_at, g.id`,
} as const;

const int = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);
/** SQLite has no boolean type; it round-trips 0/1 and the domain wants true/false. */
const bool = (v: unknown): boolean => Boolean(Number(v));

/**
 * Load everything buildSeasonSnapshot needs for one season.
 *
 * Six queries, well inside D1's 50-per-invocation limit, and the only ones on the write
 * path's rebuild step.
 */
export async function loadSeasonInput(
  db: Queryable,
  seasonSlug: string | null,
): Promise<SeasonInput | null> {
  const seasonRows = seasonSlug
    ? await db.all(SQL.season, [seasonSlug])
    : await db.all(SQL.currentSeason);
  const season = seasonRows[0];
  if (!season) return null;

  const seasonId = int(season.id);
  const [teamRows, rosterRows, roundRows, matchupRows, gameRows] = await Promise.all([
    db.all(SQL.teams, [seasonId]),
    db.all(SQL.roster, [seasonId]),
    db.all(SQL.rounds, [seasonId]),
    db.all(SQL.matchups, [seasonId]),
    db.all(SQL.games, [seasonId]),
  ]);

  const rosterByTeam = new Map<number, Row[]>();
  for (const r of rosterRows) {
    const teamId = int(r.team_id);
    const list = rosterByTeam.get(teamId);
    if (list) list.push(r);
    else rosterByTeam.set(teamId, [r]);
  }

  const teams = teamRows.map((t) => {
    const teamId = int(t.id);
    const captainCharId = int(t.captain_char_id);
    return {
      name: str(t.name),
      slug: str(t.slug),
      color: str(t.color),
      captainCharId,
      // Portrait paths and character names are reference data, derived rather than
      // stored, so a rename in reference.ts cannot drift from the database.
      captainPortrait: `portraits/${captainCharId}.png`,
      stadium: stadiumName(int(t.stadium_id)),
      roster: (rosterByTeam.get(teamId) ?? []).map((r) => {
        const charId = int(r.char_id);
        return {
          charId,
          name: charName(charId),
          captain: bool(r.is_captain),
          portrait: `portraits/${charId}.png`,
        };
      }),
    };
  });

  const teamNameById = new Map(teamRows.map((t) => [int(t.id), str(t.name)]));
  const roundNoById = new Map(roundRows.map((r) => [int(r.id), int(r.round_no)]));

  const matchupsByRound = new Map<number, [string, string][]>();
  for (const m of matchupRows) {
    const roundNo = roundNoById.get(int(m.round_id));
    if (roundNo === undefined) continue;
    const pair: [string, string] = [
      teamNameById.get(int(m.away_team_id))!,
      teamNameById.get(int(m.home_team_id))!,
    ];
    const list = matchupsByRound.get(roundNo);
    if (list) list.push(pair);
    else matchupsByRound.set(roundNo, [pair]);
  }

  const schedule: ScheduleRound[] = roundRows.map((r) => ({
    round: int(r.round_no),
    matchups: matchupsByRound.get(int(r.round_no)) ?? [],
  }));

  const games = gameRows.map((g) => ({
    gameId: str(g.rio_game_id),
    round: g.round_no === null || g.round_no === undefined ? null : int(g.round_no),
    date: int(g.played_at),
    stadiumId: int(g.stadium_id),
    innings: int(g.innings_played),
    away: str(g.away_name),
    home: str(g.home_name),
    awayScore: int(g.away_score),
    homeScore: int(g.home_score),
    boxscore: JSON.parse(str(g.box_json)) as { away: BoxPlayer[]; home: BoxPlayer[] },
  }));

  return {
    season: {
      slug: str(season.slug),
      name: str(season.name),
      shortLabel: str(season.short_label),
      startDate: str(season.start_date),
      rounds: int(season.rounds),
    },
    teams,
    schedule,
    games,
  };
}

/**
 * One game's box score, which lives outside the season snapshot.
 *
 * Box scores are roughly half the payload and are only ever needed on a single game's
 * page, so the snapshot skips them and this reads the one row that page needs.
 */
export async function getGameBoxscore(
  db: Queryable,
  seasonSlug: string,
  rioGameId: string,
): Promise<{ away: BoxPlayer[]; home: BoxPlayer[] } | null> {
  const rows = await db.all(
    `SELECT g.box_json FROM games g
     JOIN seasons s ON s.id = g.season_id
     WHERE s.slug = ? AND g.rio_game_id = ?`,
    [seasonSlug, rioGameId],
  );
  if (!rows[0]) return null;
  return JSON.parse(String(rows[0].box_json)) as { away: BoxPlayer[]; home: BoxPlayer[] };
}
