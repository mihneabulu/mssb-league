import type { APIRoute } from 'astro';

import { audit, failed, handle, seeOther } from '../../../lib/admin/respond.ts';
import {
  buildSeasonContext,
  createBatch,
  stageFile,
  stageRejected,
} from '../../../lib/db/uploads.ts';

/** Caps so a stray file cannot exhaust the request. A Rio export is ~316 KB. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/**
 * Kept well inside D1's 50-queries-per-invocation limit: committing a batch costs
 * 5 + 2 per game, and the same request then rebuilds the season snapshot (10 more).
 * Ten games is ~35 queries, with room to spare.
 */
const MAX_FILES = 10;

export const POST: APIRoute = async ({ request, locals }) =>
  handle('/admin/upload', async () => {
    const { db, actor } = locals;

    // Checked before the body is read. Doing this after formData() — as it was — meant
    // every byte had already been buffered into memory, so the guard could not actually
    // prevent the exhaustion it describes.
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_TOTAL_BYTES) {
      return failed(
        '/admin/upload',
        `That upload is ${Math.round(declared / 1024 / 1024)} MB, which is more than can be handled at once. Try fewer files.`,
      );
    }

    const form = await request.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

    if (!files.length) return failed('/admin/upload', 'Choose at least one .json file.');
    if (files.length > MAX_FILES) {
      return failed('/admin/upload', `That is more than ${MAX_FILES} files at once.`);
    }

    // Belt and braces: content-length may be absent or understated.
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      return failed(
        '/admin/upload',
        `Those files come to ${Math.round(total / 1024 / 1024)} MB, which is more than can be handled at once. Try fewer at a time.`,
      );
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
        // Staged as a rejection with a real reason. Passing empty text to stageFile
        // would surface this as "not valid JSON", which tells the reader nothing.
        await stageRejected(
          db,
          batchId,
          file.name,
          `This file is ${Math.round(file.size / 1024 / 1024)} MB. A Project Rio game file is normally under 1 MB — is it the right file?`,
        );
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
