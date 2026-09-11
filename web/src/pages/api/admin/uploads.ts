import type { APIRoute } from 'astro';

import { audit, failed, handle, seeOther } from '../../../lib/admin/respond.ts';
import { buildSeasonContext, createBatch, stageFile } from '../../../lib/db/uploads.ts';

/** Cap a single upload so a stray file cannot exhaust the request. */
const MAX_FILE_BYTES = 4 * 1024 * 1024; // a Rio export is ~316 KB
const MAX_FILES = 20;

export const POST: APIRoute = async ({ request, locals }) =>
  handle('/admin/upload', async () => {
    const { db, actor } = locals;

    const form = await request.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

    if (!files.length) return failed('/admin/upload', 'Choose at least one .json file.');
    if (files.length > MAX_FILES) {
      return failed('/admin/upload', `That is more than ${MAX_FILES} files at once.`);
    }

    const seasonRows = await db.all(`SELECT id, slug FROM seasons WHERE is_current = 1`);
    const season = seasonRows[0];
    if (!season) {
      return failed('/admin/upload', 'No season is marked as current — set one first.');
    }
    const seasonId = Number(season.id);

    const ctx = await buildSeasonContext(db, seasonId);
    const batchId = await createBatch(db, seasonId, actor.email);

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        await stageFile(db, batchId, file.name, '', ctx); // records the failure visibly
        continue;
      }
      await stageFile(db, batchId, file.name, await file.text(), ctx);
    }

    await audit(db, actor.email, 'upload.stage', {
      seasonId,
      entity: 'batch',
      entityId: batchId,
      detail: `${files.length} file(s)`,
    });

    return seeOther(`/admin/upload/${batchId}`);
  });
