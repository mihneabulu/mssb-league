import type { APIRoute } from 'astro';

import { audit, failed, handle, InputError, seeOther } from '../../../../../lib/admin/respond.ts';
import { rebuildSnapshot } from '../../../../../lib/db/snapshot.ts';
import type { CommitDecision } from '../../../../../lib/db/uploads.ts';
import { commitBatch, listStaged } from '../../../../../lib/db/uploads.ts';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const batchId = params.batchId!;
  const back = `/admin/upload/${batchId}`;

  return handle(back, async () => {
    const { db, actor } = locals;

    const batchRows = await db.all(
      `SELECT b.season_id, b.status, s.slug FROM upload_batches b
       JOIN seasons s ON s.id = b.season_id WHERE b.id = ?`,
      [batchId],
    );
    const batch = batchRows[0];
    if (!batch) return failed('/admin/upload', 'That upload batch no longer exists.');
    if (String(batch.status) === 'committed') {
      return failed(back, 'This batch has already been saved.');
    }

    const seasonId = Number(batch.season_id);
    const seasonSlug = String(batch.slug);

    const form = await request.formData();
    const stagedIds = form.getAll('staged').map((v) => Number(v));
    const staged = await listStaged(db, batchId);
    const byId = new Map(staged.map((s) => [s.id, s]));

    const decisions: CommitDecision[] = [];
    for (const id of stagedIds) {
      const row = byId.get(id);
      if (!row) continue;

      const save = form.get(`save-${id}`) !== null;
      if (!save || row.status === 'error') {
        decisions.push({ stagedId: id, skip: true, awayTeamId: 0, homeTeamId: 0, round: null });
        continue;
      }

      const away = Number(form.get(`away-${id}`));
      const home = Number(form.get(`home-${id}`));
      const roundRaw = String(form.get(`round-${id}`) ?? '');

      if (!away || !home) {
        throw new InputError(`Pick both teams for ${row.filename}, or untick it.`);
      }
      if (away === home) {
        throw new InputError(`${row.filename} has the same team on both sides.`);
      }

      decisions.push({
        stagedId: id,
        skip: false,
        awayTeamId: away,
        homeTeamId: home,
        round: roundRaw ? Number(roundRaw) : null,
      });
    }

    if (!decisions.some((d) => !d.skip)) {
      return failed(back, 'Nothing was ticked, so nothing was saved.');
    }

    const { committed, skipped } = await commitBatch(db, batchId, seasonId, decisions, actor.email);

    // Standings, leaders and every team page are recomputed from this one call, and the
    // version bump is what makes the cached pages unreachable.
    await rebuildSnapshot(db, seasonSlug);

    await audit(db, actor.email, 'upload.commit', {
      seasonId,
      entity: 'batch',
      entityId: batchId,
      detail: `${committed} saved, ${skipped} skipped`,
    });

    const msg =
      skipped > 0
        ? `Saved ${committed} game${committed === 1 ? '' : 's'} (${skipped} skipped).`
        : `Saved ${committed} game${committed === 1 ? '' : 's'}.`;
    return seeOther('/admin/games', msg);
  });
};
