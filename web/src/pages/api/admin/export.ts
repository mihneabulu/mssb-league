import type { APIRoute } from 'astro';

import { loadSeasonInput } from '../../../lib/db/queries.ts';

/**
 * Full export of one season, including box scores.
 *
 * This is the backup route: the git repo used to be the backup, and after the move to
 * D1 nothing else holds a copy. A scheduled job can call this with an Access service
 * token and commit the result.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const { db } = locals;
  const slug = url.searchParams.get('season');

  const input = await loadSeasonInput(db, slug);
  if (!input) {
    return new Response(JSON.stringify({ error: 'season not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = JSON.stringify(
    { exportedAt: new Date().toISOString(), season: input.season, data: input },
    null,
    2,
  );

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${input.season.slug}-backup.json"`,
      'cache-control': 'no-store',
    },
  });
};
