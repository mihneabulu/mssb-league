import type { APIRoute } from 'astro';

import {
  audit,
  failed,
  handle,
  InputError,
  int,
  optionalInt,
  required,
  safeColor,
  seeOther,
  slugify,
  str,
} from '../../../../lib/admin/respond.ts';
import type { TeamInput } from '../../../../lib/db/admin.ts';
import {
  addTeam,
  deleteSeason,
  deleteTeam,
  makeCurrent,
  saveTeams,
  updateSeason,
} from '../../../../lib/db/admin.ts';
import { rebuildSnapshot } from '../../../../lib/db/snapshot.ts';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const slug = params.slug!;
  const back = `/admin/seasons/${slug}`;

  return handle(back, async () => {
    const { db, actor } = locals;
    const rows = await db.all(`SELECT id FROM seasons WHERE slug = ?`, [slug]);
    if (!rows[0]) return failed('/admin/seasons', 'That season no longer exists.');
    const seasonId = Number(rows[0].id);

    const form = await request.formData();
    const action = str(form, '_action');

    // The per-row remove button posts the whole teams form but carries its own value,
    // so this is checked before the form-wide action.
    const removeTeam = str(form, 'removeTeam');
    if (removeTeam) {
      await deleteTeam(db, seasonId, Number(removeTeam));
      await audit(db, actor.email, 'team.delete', {
        seasonId,
        entity: 'team',
        entityId: removeTeam,
      });
      return seeOther(back, 'Team removed.');
    }

    if (action === 'make-current') {
      await makeCurrent(db, seasonId);
      await audit(db, actor.email, 'season.make-current', {
        seasonId,
        entity: 'season',
        entityId: slug,
      });
      return seeOther('/admin/seasons', `${slug} is now the season the site opens on.`);
    }

    if (action === 'delete') {
      await deleteSeason(db, seasonId);
      await audit(db, actor.email, 'season.delete', { entity: 'season', entityId: slug });
      return seeOther('/admin/seasons', 'Season deleted.');
    }

    if (action === 'add-team') {
      const name = required(form, 'teamName', 'Team name');
      await addTeam(db, seasonId, name);
      await audit(db, actor.email, 'team.add', { seasonId, entity: 'team', detail: name });
      return seeOther(back, `Added ${name}. Give it colours and a stadium, then draft its roster.`);
    }

    if (action === 'delete-team') {
      const teamId = int(form, 'teamId', 'Team');
      await deleteTeam(db, seasonId, teamId);
      await audit(db, actor.email, 'team.delete', { seasonId, entity: 'team', entityId: teamId });
      return seeOther(back, 'Team removed.');
    }

    if (action === 'save-teams') {
      const ids = form.getAll('teamId').map((v) => Number(v));
      const teams: TeamInput[] = ids.map((id, i) => {
        const name = str(form, `name-${id}`);
        if (!name) throw new InputError('Every team needs a name.');
        return {
          id,
          name,
          slug: slugify(str(form, `slug-${id}`) || name),
          color: safeColor(str(form, `color-${id}`)),
          stadiumId: optionalInt(form, `stadium-${id}`),
          captainCharId: optionalInt(form, `captain-${id}`),
          sortOrder: i,
        };
      });
      await saveTeams(db, seasonId, teams);
      await rebuildSnapshot(db, slug);
      await audit(db, actor.email, 'team.save', {
        seasonId,
        entity: 'team',
        detail: `${teams.length} teams`,
      });
      return seeOther(back, 'Teams saved.');
    }

    // Otherwise: the season's own details.
    const name = required(form, 'name', 'Name');
    const shortLabel = required(form, 'shortLabel', 'Short label');
    const startDate = required(form, 'startDate', 'First day');
    const status = str(form, 'status') || 'draft';
    const rounds = optionalInt(form, 'rounds') ?? 0;

    await updateSeason(db, seasonId, { name, shortLabel, startDate, rounds, status });
    await rebuildSnapshot(db, slug);
    await audit(db, actor.email, 'season.update', { seasonId, entity: 'season', entityId: slug });
    return seeOther(back, 'Season details saved.');
  });
};
