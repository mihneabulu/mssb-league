// Write operations behind the admin screens.
//
// Everything here is written to survive a non-technical person doing something
// reasonable-but-unexpected: renaming a team mid-season, regenerating a schedule after
// games are played, drafting a character another team already has. Where that would
// destroy data, these refuse rather than proceed.

import { InputError, now, safeColor, slugify } from '../admin/respond.ts';
import type { GeneratedRound } from '../admin/schedule.ts';
import { CHARACTER_COUNT } from '../mssb/reference.ts';
import type { Executable, Row, Statement } from './queries.ts';

/** D1 allows 100 bound parameters per query, so multi-row inserts are chunked. */
function chunkedInsert(
  sql: string,
  rowSql: string,
  rows: unknown[][],
  paramsPerRow: number,
): Statement[] {
  if (!rows.length) return [];
  const perStatement = Math.max(1, Math.floor(90 / paramsPerRow));
  const out: Statement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const slice = rows.slice(i, i + perStatement);
    out.push({
      sql: `${sql} VALUES ${slice.map(() => rowSql).join(', ')}`,
      params: slice.flat(),
    });
  }
  return out;
}

// --- seasons -------------------------------------------------------------------------

export async function getSeason(db: Executable, slug: string): Promise<Row | null> {
  const rows = await db.all(`SELECT * FROM seasons WHERE slug = ?`, [slug]);
  return rows[0] ?? null;
}

export async function createSeason(
  db: Executable,
  input: { slug: string; name: string; shortLabel: string; startDate: string; rounds: number },
  cloneTeamsFrom?: number | null,
): Promise<number> {
  const existing = await db.all(`SELECT id FROM seasons WHERE slug = ?`, [input.slug]);
  if (existing.length) throw new InputError(`A season with the slug "${input.slug}" already exists.`);

  const ts = now();
  const seasonId = await db.insert(
    `INSERT INTO seasons (slug, name, short_label, start_date, rounds, status, is_current, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
    [input.slug, input.name, input.shortLabel, input.startDate, input.rounds, ts, ts],
  );

  if (cloneTeamsFrom) {
    // Names, colours, stadiums and order carry over; rosters deliberately do not,
    // because a new season means a new draft.
    const teams = await db.all(
      `SELECT slug, name, color, stadium_id, sort_order FROM teams WHERE season_id = ? ORDER BY sort_order, id`,
      [cloneTeamsFrom],
    );
    const rows = teams.map((t) => [
      seasonId,
      String(t.slug),
      String(t.name),
      String(t.color),
      t.stadium_id === null ? null : Number(t.stadium_id),
      Number(t.sort_order),
      ts,
      ts,
    ]);
    await db.batch(
      chunkedInsert(
        `INSERT INTO teams (season_id, slug, name, color, stadium_id, sort_order, created_at, updated_at)`,
        '(?, ?, ?, ?, ?, ?, ?, ?)',
        rows,
        8,
      ),
    );
  }

  return seasonId;
}

export async function makeCurrent(db: Executable, seasonId: number): Promise<void> {
  // The partial unique index allows only one row with is_current = 1, so the old one
  // must be cleared in the same batch.
  await db.batch([
    { sql: `UPDATE seasons SET is_current = 0 WHERE is_current = 1` },
    { sql: `UPDATE seasons SET is_current = 1, updated_at = ? WHERE id = ?`, params: [now(), seasonId] },
  ]);
}

export async function updateSeason(
  db: Executable,
  seasonId: number,
  input: { name: string; shortLabel: string; startDate: string; rounds: number; status: string },
): Promise<void> {
  await db.run(
    `UPDATE seasons SET name = ?, short_label = ?, start_date = ?, rounds = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [input.name, input.shortLabel, input.startDate, input.rounds, input.status, now(), seasonId],
  );
}

export async function deleteSeason(db: Executable, seasonId: number): Promise<void> {
  const games = await db.all(`SELECT COUNT(*) AS n FROM games WHERE season_id = ?`, [seasonId]);
  if (Number(games[0]?.n) > 0) {
    throw new InputError(
      'That season has games recorded. Delete the games first if you really mean to remove it.',
    );
  }
  await db.run(`DELETE FROM seasons WHERE id = ?`, [seasonId]);
}

// --- teams ---------------------------------------------------------------------------

export type TeamInput = {
  id: number | null;
  name: string;
  slug: string;
  color: string;
  stadiumId: number | null;
  captainCharId: number | null;
  sortOrder: number;
};

export async function saveTeams(
  db: Executable,
  seasonId: number,
  teams: TeamInput[],
): Promise<void> {
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const t of teams) {
    if (!t.name) throw new InputError('Every team needs a name.');
    if (names.has(t.name.toLowerCase())) throw new InputError(`Two teams are both called "${t.name}".`);
    if (slugs.has(t.slug)) throw new InputError(`Two teams share the address "${t.slug}".`);
    names.add(t.name.toLowerCase());
    slugs.add(t.slug);
  }

  const ts = now();
  const statements: Statement[] = teams.map((t) =>
    t.id
      ? {
          sql: `UPDATE teams SET name = ?, slug = ?, color = ?, stadium_id = ?, captain_char_id = ?, sort_order = ?, updated_at = ?
                WHERE id = ? AND season_id = ?`,
          params: [t.name, t.slug, t.color, t.stadiumId, t.captainCharId, t.sortOrder, ts, t.id, seasonId],
        }
      : {
          sql: `INSERT INTO teams (season_id, slug, name, color, stadium_id, captain_char_id, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [seasonId, t.slug, t.name, t.color, t.stadiumId, t.captainCharId, t.sortOrder, ts, ts],
        },
  );
  await db.batch(statements);
}

export async function addTeam(db: Executable, seasonId: number, name: string): Promise<number> {
  const slug = slugify(name);
  if (!slug) throw new InputError('That team name cannot be turned into a web address.');
  const clash = await db.all(`SELECT id FROM teams WHERE season_id = ? AND (slug = ? OR name = ?)`, [
    seasonId,
    slug,
    name,
  ]);
  if (clash.length) throw new InputError(`This season already has a team called "${name}".`);

  const order = await db.all(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM teams WHERE season_id = ?`,
    [seasonId],
  );
  const ts = now();
  return db.insert(
    `INSERT INTO teams (season_id, slug, name, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [seasonId, slug, name, safeColor(''), Number(order[0]?.next ?? 0), ts, ts],
  );
}

export async function deleteTeam(db: Executable, seasonId: number, teamId: number): Promise<void> {
  const games = await db.all(
    `SELECT COUNT(*) AS n FROM games WHERE season_id = ? AND (away_team_id = ? OR home_team_id = ?)`,
    [seasonId, teamId, teamId],
  );
  if (Number(games[0]?.n) > 0) {
    throw new InputError('That team has played games. Delete or reassign those games first.');
  }
  await db.run(`DELETE FROM teams WHERE id = ? AND season_id = ?`, [teamId, seasonId]);
}

// --- rosters -------------------------------------------------------------------------

export type RosterOwner = { charId: number; teamId: number; teamName: string; color: string };

/** Who owns each drafted character this season — drives the disabled cells in the grid. */
export async function rosterOwnership(db: Executable, seasonId: number): Promise<RosterOwner[]> {
  const rows = await db.all(
    `SELECT r.char_id, r.team_id, t.name, t.color
     FROM roster_slots r JOIN teams t ON t.id = r.team_id
     WHERE r.season_id = ? ORDER BY r.char_id`,
    [seasonId],
  );
  return rows.map((r) => ({
    charId: Number(r.char_id),
    teamId: Number(r.team_id),
    teamName: String(r.name),
    color: String(r.color),
  }));
}

export async function saveRoster(
  db: Executable,
  seasonId: number,
  teamId: number,
  charIds: number[],
  captainCharId: number | null,
): Promise<void> {
  const unique = [...new Set(charIds)].sort((a, b) => a - b);
  if (unique.length !== charIds.length) throw new InputError('A character was selected twice.');
  for (const id of unique) {
    if (!Number.isInteger(id) || id < 0 || id >= CHARACTER_COUNT) {
      throw new InputError(`${id} is not a valid character.`);
    }
  }
  if (captainCharId !== null && !unique.includes(captainCharId)) {
    throw new InputError('The captain must be one of the selected characters.');
  }

  // The (season_id, char_id) primary key makes double-drafting a database error, but
  // checking first turns it into a sentence a human can act on.
  if (unique.length) {
    const placeholders = unique.map(() => '?').join(',');
    const taken = await db.all(
      `SELECT r.char_id, t.name FROM roster_slots r JOIN teams t ON t.id = r.team_id
       WHERE r.season_id = ? AND r.team_id != ? AND r.char_id IN (${placeholders})`,
      [seasonId, teamId, ...unique],
    );
    if (taken.length) {
      const names = taken.map((t) => String(t.name));
      throw new InputError(
        `Already drafted by ${[...new Set(names)].join(', ')}. Someone may have picked while this page was open — reload and try again.`,
      );
    }
  }

  const rows = unique.map((charId) => [
    seasonId,
    teamId,
    charId,
    captainCharId === charId ? 1 : 0,
  ]);

  await db.batch([
    { sql: `DELETE FROM roster_slots WHERE season_id = ? AND team_id = ?`, params: [seasonId, teamId] },
    ...chunkedInsert(
      `INSERT INTO roster_slots (season_id, team_id, char_id, is_captain)`,
      '(?, ?, ?, ?)',
      rows,
      4,
    ),
    {
      sql: `UPDATE teams SET captain_char_id = ?, updated_at = ? WHERE id = ?`,
      params: [captainCharId, now(), teamId],
    },
  ]);
}

// --- schedule ------------------------------------------------------------------------

/**
 * Replace a season's schedule.
 *
 * Round rows are reused by number rather than deleted and recreated, because games
 * reference them: dropping a round would silently unassign every game in it. A round
 * that disappears entirely is refused while it still has games attached.
 */
export async function saveSchedule(
  db: Executable,
  seasonId: number,
  rounds: GeneratedRound[],
): Promise<void> {
  const existing = await db.all(
    `SELECT id, round_no FROM rounds WHERE season_id = ? ORDER BY round_no`,
    [seasonId],
  );
  const idByRoundNo = new Map(existing.map((r) => [Number(r.round_no), Number(r.id)]));
  const keeping = new Set(rounds.map((r) => r.round));

  const doomed = existing.filter((r) => !keeping.has(Number(r.round_no)));
  if (doomed.length) {
    const ids = doomed.map((r) => Number(r.id));
    const attached = await db.all(
      `SELECT COUNT(*) AS n FROM games WHERE round_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    if (Number(attached[0]?.n) > 0) {
      throw new InputError(
        'The new schedule has fewer rounds than there are rounds with games recorded. Move or delete those games first.',
      );
    }
  }

  for (const r of rounds) {
    if (!idByRoundNo.has(r.round)) {
      const id = await db.insert(`INSERT INTO rounds (season_id, round_no) VALUES (?, ?)`, [
        seasonId,
        r.round,
      ]);
      idByRoundNo.set(r.round, id);
    }
  }

  const statements: Statement[] = [];
  if (doomed.length) {
    statements.push({
      sql: `DELETE FROM rounds WHERE id IN (${doomed.map(() => '?').join(',')})`,
      params: doomed.map((r) => Number(r.id)),
    });
  }
  statements.push({ sql: `DELETE FROM matchups WHERE season_id = ?`, params: [seasonId] });

  const rows: unknown[][] = [];
  for (const r of rounds) {
    const roundId = idByRoundNo.get(r.round)!;
    r.matchups.forEach(([awayTeamId, homeTeamId], slot) => {
      rows.push([seasonId, roundId, slot, awayTeamId, homeTeamId]);
    });
  }
  statements.push(
    ...chunkedInsert(
      `INSERT INTO matchups (season_id, round_id, slot, away_team_id, home_team_id)`,
      '(?, ?, ?, ?, ?)',
      rows,
      5,
    ),
  );

  await db.batch(statements);
  await db.run(`UPDATE seasons SET rounds = ?, updated_at = ? WHERE id = ?`, [
    rounds.length,
    now(),
    seasonId,
  ]);
}

// --- games ---------------------------------------------------------------------------

export async function updateGame(
  db: Executable,
  gameId: number,
  input: { roundId: number | null; awayTeamId: number; homeTeamId: number; notes: string | null },
): Promise<void> {
  if (input.awayTeamId === input.homeTeamId) {
    throw new InputError('A team cannot play itself.');
  }
  await db.run(
    `UPDATE games SET round_id = ?, away_team_id = ?, home_team_id = ?, notes = ? WHERE id = ?`,
    [input.roundId, input.awayTeamId, input.homeTeamId, input.notes, gameId],
  );
}

export async function deleteGame(db: Executable, gameId: number): Promise<void> {
  // game_raw is kept deliberately: the archived upload is the only copy of the original
  // file, and losing it would make a mistaken delete unrecoverable.
  await db.run(`UPDATE games SET raw_id = NULL WHERE id = ?`, [gameId]);
  await db.run(`DELETE FROM games WHERE id = ?`, [gameId]);
}
