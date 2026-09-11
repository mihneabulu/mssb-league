import type { APIRoute } from 'astro';

import { toBytes } from '../../../../lib/db/uploads.ts';

/**
 * The archived original Project Rio uploads.
 *
 * These are the only copies once a season is no longer in `results/`, and they are what
 * makes a parser fix retroactive — "re-read file" replays them. They are excluded from
 * the main JSON export because they are binary and would bloat a document meant to be
 * diffable, so the backup job fetches them separately.
 *
 *   /api/admin/export/raw          -> manifest of every archived upload
 *   /api/admin/export/raw?id=12    -> that upload, gzipped, exactly as stored
 *
 * They never change once written, so a backup only ever has to fetch the ones it is
 * missing.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const { db } = locals;
  const id = url.searchParams.get('id');

  if (!id) {
    const rows = await db.all(
      `SELECT r.id, r.rio_game_id, r.sha256, r.filename, r.size_raw, r.size_gz,
              r.was_decoded, r.uploaded_at, r.uploaded_by, s.slug AS season
       FROM game_raw r JOIN seasons s ON s.id = r.season_id
       ORDER BY s.start_date, r.id`,
    );

    const files = rows.map((r) => ({
      id: Number(r.id),
      season: String(r.season),
      rioGameId: String(r.rio_game_id),
      // sha256 of the DECOMPRESSED original, so a restored file can be checked by
      // gunzipping it and hashing the result.
      sha256: String(r.sha256),
      filename: r.filename === null ? null : String(r.filename),
      sizeRaw: Number(r.size_raw),
      sizeGz: Number(r.size_gz),
      wasDecoded: Boolean(Number(r.was_decoded)),
      uploadedAt: Number(r.uploaded_at),
      uploadedBy: r.uploaded_by === null ? null : String(r.uploaded_by),
    }));

    return new Response(
      JSON.stringify({ generatedAt: new Date().toISOString(), schema: 1, files }, null, 2),
      { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const rows = await db.all(
    `SELECT r.bytes_gz, r.rio_game_id, s.slug AS season
     FROM game_raw r JOIN seasons s ON s.id = r.season_id
     WHERE r.id = ?`,
    [Number(id)],
  );
  const row = rows[0];
  if (!row) {
    return new Response(JSON.stringify({ error: 'no such upload' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // D1 returns a BLOB as number[]; Response needs real bytes.
  const bytes = toBytes(row.bytes_gz);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${row.season}-${row.rio_game_id}.json.gz"`,
      'cache-control': 'no-store',
    },
  });
};
