import type { APIRoute } from 'astro';

import { loadSeasonInput } from '../../../lib/db/queries.ts';

/**
 * Full export of the league, including box scores.
 *
 * This is the backup route. The git repo used to *be* the backup — every game arrived as
 * a commit — and after the move to D1 nothing else holds a copy of data a non-technical
 * person is typing in. A scheduled job calls this with an Access service token and
 * commits the result.
 *
 *   /api/admin/export                -> every season
 *   /api/admin/export?season=s1      -> one season
 *
 * What this does NOT include is the archived original uploads (game_raw): they are
 * binary and only needed to re-parse a game after a parser fix, not to reconstitute the
 * league. Download those individually from Tools if you need them.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const { db } = locals;
  const wanted = url.searchParams.get('season');

  const slugs = wanted
    ? [wanted]
    : (await db.all(`SELECT slug FROM seasons ORDER BY start_date, id`)).map((r) => String(r.slug));

  const seasons = [];
  for (const slug of slugs) {
    const input = await loadSeasonInput(db, slug);
    if (input) seasons.push(input);
  }

  if (!seasons.length) {
    return new Response(JSON.stringify({ error: 'no matching season' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      schema: 1,
      seasons,
    },
    null,
    2,
  );

  const filename = wanted ? `${wanted}-backup.json` : 'league-backup.json';
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
};
