// The upload pipeline: stage first, commit second.
//
// Files are analyzed and stored server-side before anything is shown, so the review
// survives a reload, a partial commit is recoverable, and a 316 KB file never has to
// make a second trip through the browser.

import { now } from '../admin/respond.ts';
import type { AnalyzedGame, SeasonContext } from '../mssb/ingest.ts';
import { analyzeUpload } from '../mssb/ingest.ts';
import { buildRosterIndex } from '../mssb/identify.ts';
import { stadiumName } from '../mssb/reference.ts';
import type { Executable, Row } from './queries.ts';

// --- compression ---------------------------------------------------------------------

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function gzip(text: string): Promise<Uint8Array> {
  const input = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return streamToBytes(input as ReadableStream<Uint8Array>);
}

export async function gunzip(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // Copy into a plain ArrayBuffer-backed view: D1 hands back a buffer whose type is
  // ArrayBufferLike, which Blob does not accept.
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = new Uint8Array(source.length);
  buf.set(source);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await streamToBytes(stream as ReadableStream<Uint8Array>));
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- season context ------------------------------------------------------------------

/** Everything analyzeUpload needs to identify a game against a particular season. */
export async function buildSeasonContext(
  db: Executable,
  seasonId: number,
): Promise<SeasonContext> {
  const [seasonRows, teamRows, rosterRows, matchupRows, playedRows] = await Promise.all([
    db.all(`SELECT slug, name, short_label, start_date, rounds FROM seasons WHERE id = ?`, [seasonId]),
    db.all(`SELECT id, slug, name, stadium_id FROM teams WHERE season_id = ? ORDER BY sort_order, id`, [seasonId]),
    db.all(`SELECT team_id, char_id FROM roster_slots WHERE season_id = ?`, [seasonId]),
    db.all(
      `SELECT m.away_team_id, m.home_team_id, r.round_no,
              EXISTS (SELECT 1 FROM games g WHERE g.matchup_id = m.id) AS played
       FROM matchups m JOIN rounds r ON r.id = m.round_id
       WHERE m.season_id = ? ORDER BY r.round_no, m.slot`,
      [seasonId],
    ),
    db.all(`SELECT rio_game_id FROM games WHERE season_id = ?`, [seasonId]),
  ]);

  const season = seasonRows[0];
  if (!season) throw new Error(`season ${seasonId} not found`);

  const charsByTeam = new Map<number, number[]>();
  for (const r of rosterRows) {
    const teamId = Number(r.team_id);
    const list = charsByTeam.get(teamId);
    if (list) list.push(Number(r.char_id));
    else charsByTeam.set(teamId, [Number(r.char_id)]);
  }

  return {
    season: {
      slug: String(season.slug),
      name: String(season.name),
      shortLabel: String(season.short_label),
      startDate: String(season.start_date),
      rounds: Number(season.rounds),
    },
    teams: teamRows.map((t) => ({
      teamId: Number(t.id),
      slug: String(t.slug),
      name: String(t.name),
      stadium: t.stadium_id === null ? null : stadiumName(Number(t.stadium_id)),
    })),
    rosterIndex: buildRosterIndex(
      teamRows.map((t) => ({
        teamId: Number(t.id),
        slug: String(t.slug),
        name: String(t.name),
        charIds: charsByTeam.get(Number(t.id)) ?? [],
      })),
    ),
    matchups: matchupRows.map((m) => ({
      round: Number(m.round_no),
      awayTeamId: Number(m.away_team_id),
      homeTeamId: Number(m.home_team_id),
      played: Boolean(Number(m.played)),
    })),
    playedRioIds: new Set(playedRows.map((r) => String(r.rio_game_id))),
  };
}

// --- staging -------------------------------------------------------------------------

export type StagedRow = {
  id: number;
  filename: string;
  status: string;
  error: string | null;
  analyzed: AnalyzedGame;
  sha256: string;
  suggestedAwayTeamId: number | null;
  suggestedHomeTeamId: number | null;
  suggestedRound: number | null;
};

export async function createBatch(
  db: Executable,
  seasonId: number,
  actorEmail: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO upload_batches (id, season_id, created_at, created_by, status) VALUES (?, ?, ?, ?, 'open')`,
    [id, seasonId, now(), actorEmail],
  );
  // Opportunistic cleanup — one statement, no cron needed.
  await db.run(
    `DELETE FROM upload_batches WHERE status = 'open' AND created_at < ?`,
    [now() - 7 * 24 * 3600],
  );
  return id;
}

export async function stageFile(
  db: Executable,
  batchId: string,
  filename: string,
  text: string,
  ctx: SeasonContext,
): Promise<void> {
  const analyzed = analyzeUpload(text, filename, ctx);
  const digest = await sha256(text);

  // A byte-identical re-upload of a game already recorded is a duplicate regardless of
  // what the file is called.
  if (analyzed.status !== 'error') {
    const seen = await db.all(`SELECT id FROM game_raw WHERE sha256 = ?`, [digest]);
    if (seen.length) {
      analyzed.status = 'duplicate';
      analyzed.warnings = [
        ...analyzed.warnings,
        { kind: 'duplicate', message: 'This exact file has already been uploaded.' },
      ];
    }
  }

  const confidence =
    analyzed.away.exact && analyzed.home.exact
      ? 'exact'
      : analyzed.away.teamId !== null && analyzed.home.teamId !== null
        ? 'fuzzy'
        : 'none';

  // The raw bytes are kept even for a file that failed to parse, so a parser fix can
  // recover it later rather than needing the person to find the file again.
  const raw = await gzip(text);

  await db.run(
    `INSERT INTO staged_games
       (batch_id, filename, status, error, analyzed_json, raw_gz, sha256,
        sug_away_team_id, sug_home_team_id, sug_round_id, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
      filename,
      analyzed.status,
      analyzed.error ?? null,
      JSON.stringify({ ...analyzed, normalized: undefined }),
      raw,
      digest,
      analyzed.away.teamId,
      analyzed.home.teamId,
      analyzed.suggestedRound,
      confidence,
    ],
  );
}

export async function listStaged(db: Executable, batchId: string): Promise<StagedRow[]> {
  const rows = await db.all(
    `SELECT id, filename, status, error, analyzed_json, sha256,
            sug_away_team_id, sug_home_team_id, sug_round_id
     FROM staged_games WHERE batch_id = ? ORDER BY id`,
    [batchId],
  );
  return rows.map(toStagedRow);
}

function toStagedRow(r: Row): StagedRow {
  return {
    id: Number(r.id),
    filename: String(r.filename),
    status: String(r.status),
    error: r.error === null ? null : String(r.error),
    analyzed: JSON.parse(String(r.analyzed_json)) as AnalyzedGame,
    sha256: String(r.sha256),
    suggestedAwayTeamId: r.sug_away_team_id === null ? null : Number(r.sug_away_team_id),
    suggestedHomeTeamId: r.sug_home_team_id === null ? null : Number(r.sug_home_team_id),
    suggestedRound: r.sug_round_id === null ? null : Number(r.sug_round_id),
  };
}

export type CommitDecision = {
  stagedId: number;
  skip: boolean;
  awayTeamId: number;
  homeTeamId: number;
  round: number | null;
};

export async function commitBatch(
  db: Executable,
  batchId: string,
  seasonId: number,
  decisions: CommitDecision[],
  actorEmail: string,
): Promise<{ committed: number; skipped: number }> {
  const staged = await listStaged(db, batchId);
  const byId = new Map(staged.map((s) => [s.id, s]));

  const roundRows = await db.all(`SELECT id, round_no FROM rounds WHERE season_id = ?`, [seasonId]);
  const roundIdByNo = new Map(roundRows.map((r) => [Number(r.round_no), Number(r.id)]));

  const matchupRows = await db.all(
    `SELECT m.id, m.round_id, m.away_team_id, m.home_team_id FROM matchups m WHERE m.season_id = ?`,
    [seasonId],
  );

  let committed = 0;
  let skipped = 0;
  const ts = now();

  for (const decision of decisions) {
    const row = byId.get(decision.stagedId);
    if (!row || decision.skip || row.status === 'error') {
      skipped++;
      continue;
    }

    const rawText = await gunzip(
      (await db.all(`SELECT raw_gz FROM staged_games WHERE id = ?`, [row.id]))[0]
        .raw_gz as ArrayBuffer,
    );
    const a = row.analyzed;

    const roundId = decision.round === null ? null : (roundIdByNo.get(decision.round) ?? null);
    const matchup =
      matchupRows.find(
        (m) =>
          Number(m.round_id) === roundId &&
          ((Number(m.away_team_id) === decision.awayTeamId &&
            Number(m.home_team_id) === decision.homeTeamId) ||
            (Number(m.away_team_id) === decision.homeTeamId &&
              Number(m.home_team_id) === decision.awayTeamId)),
      ) ?? null;

    const gz = await gzip(rawText);
    const rawId = await db.insert(
      `INSERT INTO game_raw (season_id, rio_game_id, sha256, filename, bytes_gz, size_raw, size_gz, was_decoded, uploaded_at, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seasonId,
        a.rioGameId,
        row.sha256,
        row.filename,
        gz,
        rawText.length,
        gz.length,
        a.wasDecoded ? 1 : 0,
        ts,
        actorEmail,
      ],
    );

    await db.run(
      `INSERT INTO games
         (season_id, rio_game_id, round_id, matchup_id, away_team_id, home_team_id,
          away_score, home_score, innings_played, stadium_id, played_at, ended_at,
          detection, box_json, raw_id, source_name, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seasonId,
        a.rioGameId,
        roundId,
        matchup ? Number(matchup.id) : null,
        decision.awayTeamId,
        decision.homeTeamId,
        a.awayScore,
        a.homeScore,
        a.innings,
        a.stadiumId,
        a.playedAt,
        a.endedAt,
        JSON.stringify({
          away: { exact: a.away.exact, overlap: a.away.overlap },
          home: { exact: a.home.exact, overlap: a.home.overlap },
          wasDecoded: a.wasDecoded,
          warnings: a.warnings.map((w) => w.kind),
          confirmedBy: actorEmail,
        }),
        JSON.stringify(a.boxscore),
        rawId,
        row.filename,
        actorEmail,
        ts,
      ],
    );
    committed++;
  }

  await db.run(`UPDATE upload_batches SET status = 'committed' WHERE id = ?`, [batchId]);
  return { committed, skipped };
}
