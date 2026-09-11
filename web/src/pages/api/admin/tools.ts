import type { APIRoute } from 'astro';

import { audit, failed, handle, required, seeOther } from '../../../lib/admin/respond.ts';
import { rebuildSnapshot } from '../../../lib/db/snapshot.ts';

export const POST: APIRoute = async ({ request, locals }) =>
  handle('/admin/tools', async () => {
    const { db, actor } = locals;
    const form = await request.formData();
    const slug = required(form, 'season', 'Season');

    const result = await rebuildSnapshot(db, slug);
    if (!result) return failed('/admin/tools', 'That season no longer exists.');

    await audit(db, actor.email, 'snapshot.rebuild', {
      entity: 'season',
      entityId: slug,
      detail: `version ${result.version}`,
    });
    return seeOther('/admin/tools', `Rebuilt ${slug} (version ${result.version}).`);
  });
