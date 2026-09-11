import type { APIRoute } from 'astro';

import { audit, handle, InputError, required, seeOther, slugify, str } from '../../../lib/admin/respond.ts';
import { createSeason } from '../../../lib/db/admin.ts';
import { rebuildSnapshot } from '../../../lib/db/snapshot.ts';
import { isValidSeasonSlug, RESERVED_SLUGS } from '../../../lib/links.ts';

export const POST: APIRoute = async ({ request, locals }) =>
  handle('/admin/seasons', async () => {
    const { db, actor } = locals;
    const form = await request.formData();

    const name = required(form, 'name', 'Name');
    const shortLabel = required(form, 'shortLabel', 'Short label');
    const startDate = required(form, 'startDate', 'First day');
    const slug = slugify(str(form, 'slug') || shortLabel);

    if (!isValidSeasonSlug(slug)) {
      throw new InputError(
        RESERVED_SLUGS.has(slug)
          ? `"${slug}" is reserved — the site already uses that address. Pick another.`
          : `"${slug}" is not a usable web address. Use letters, numbers and dashes.`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new InputError('The first day should look like 2027-06-28.');
    }

    const cloneRaw = str(form, 'cloneFrom');
    const cloneFrom = cloneRaw ? Number(cloneRaw) : null;

    const seasonId = await createSeason(
      db,
      { slug, name, shortLabel, startDate, rounds: 0 },
      cloneFrom,
    );

    // Build the snapshot immediately. Without a row, getSeasonVersion returns 0 for the
    // life of the season, so its pages cache under a key that never rotates — and the
    // stored copy has a one-year max-age. The first edit would fix it by bumping the
    // version, but until then a new season's pages would be frozen at creation.
    await rebuildSnapshot(db, slug);

    await audit(db, actor.email, 'season.create', {
      seasonId,
      entity: 'season',
      entityId: slug,
      detail: cloneFrom ? `cloned teams from season ${cloneFrom}` : 'empty',
    });

    return seeOther(
      `/admin/seasons/${slug}`,
      'Season created. Next: check the teams, run the draft, then build the schedule.',
    );
  });
