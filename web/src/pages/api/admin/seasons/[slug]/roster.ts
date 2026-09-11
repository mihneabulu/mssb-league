import type { APIRoute } from 'astro';

import {
  audit,
  failed,
  handle,
  InputError,
  int,
  optionalInt,
  seeOther,
  str,
} from '../../../../../lib/admin/respond.ts';
import { saveRoster } from '../../../../../lib/db/admin.ts';
import { rebuildSnapshot } from '../../../../../lib/db/snapshot.ts';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const slug = params.slug!;

  return handle(`/admin/seasons/${slug}`, async () => {
    const { db, actor } = locals;
    const form = await request.formData();
    const teamId = int(form, 'teamId', 'Team');
    const back = `/admin/seasons/${slug}/roster/${teamId}`;

    const seasonRows = await db.all(`SELECT id FROM seasons WHERE slug = ?`, [slug]);
    if (!seasonRows[0]) return failed('/admin/seasons', 'That season no longer exists.');
    const seasonId = Number(seasonRows[0].id);

    const teamRows = await db.all(
      `SELECT name, updated_at FROM teams WHERE id = ? AND season_id = ?`,
      [teamId, seasonId],
    );
    if (!teamRows[0]) return failed(`/admin/seasons/${slug}`, 'That team no longer exists.');

    // Someone else may have drafted while this page sat open; the disabled cells the
    // browser rendered are only a snapshot.
    const expected = str(form, 'expectedUpdatedAt');
    if (expected && expected !== String(teamRows[0].updated_at)) {
      return failed(
        back,
        'Someone else changed this roster while you had it open. Reload to see the current picks, then try again.',
      );
    }

    const charIds = form.getAll('chars').map((v) => Number(v));
    if (charIds.length > 9) throw new InputError('A team can only field nine characters.');

    const captain = optionalInt(form, 'captain');
    await saveRoster(db, seasonId, teamId, charIds, captain);
    await rebuildSnapshot(db, slug);

    await audit(db, actor.email, 'roster.save', {
      seasonId,
      entity: 'team',
      entityId: teamId,
      detail: `${charIds.length} characters`,
    });

    const short = charIds.length < 9 ? ` (${9 - charIds.length} still to pick)` : '';
    return seeOther(`/admin/seasons/${slug}`, `${teamRows[0].name} roster saved${short}.`);
  });
};
