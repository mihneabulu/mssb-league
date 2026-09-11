import type { APIRoute } from 'astro';

import { audit, failed, handle, InputError, seeOther, str } from '../../../../../lib/admin/respond.ts';
import type { GeneratedRound } from '../../../../../lib/admin/schedule.ts';
import { doubleRoundRobin } from '../../../../../lib/admin/schedule.ts';
import { saveSchedule } from '../../../../../lib/db/admin.ts';
import { rebuildSnapshot } from '../../../../../lib/db/snapshot.ts';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const slug = params.slug!;
  const back = `/admin/seasons/${slug}/schedule`;

  return handle(back, async () => {
    const { db, actor } = locals;

    const seasonRows = await db.all(`SELECT id FROM seasons WHERE slug = ?`, [slug]);
    if (!seasonRows[0]) return failed('/admin/seasons', 'That season no longer exists.');
    const seasonId = Number(seasonRows[0].id);

    const teams = await db.all(
      `SELECT id FROM teams WHERE season_id = ? ORDER BY sort_order, id`,
      [seasonId],
    );
    if (teams.length < 2) throw new InputError('Add at least two teams first.');

    const form = await request.formData();
    const action = str(form, '_action');

    let rounds: GeneratedRound[];

    if (action === 'generate') {
      rounds = doubleRoundRobin(teams.map((t) => Number(t.id)));
    } else {
      // Read back whatever the editor posted: m-<round>-<slot>-away / -home.
      const valid = new Set(teams.map((t) => Number(t.id)));
      const collected = new Map<number, [number, number][]>();

      for (const [key, value] of form.entries()) {
        const m = /^m-(\d+)-(\d+)-away$/.exec(key);
        if (!m) continue;
        const roundNo = Number(m[1]);
        const slot = Number(m[2]);
        const away = Number(value);
        const home = Number(form.get(`m-${roundNo}-${slot}-home`));

        // Both empty means the fixture was deliberately removed.
        if (!away && !home) continue;
        if (!away || !home) {
          throw new InputError(`Round ${roundNo} has a fixture with only one team set.`);
        }
        if (away === home) throw new InputError(`Round ${roundNo} has a team playing itself.`);
        if (!valid.has(away) || !valid.has(home)) {
          throw new InputError(`Round ${roundNo} refers to a team that is not in this season.`);
        }
        collected.set(roundNo, [...(collected.get(roundNo) ?? []), [away, home]]);
      }

      if (!collected.size) throw new InputError('That would leave no fixtures at all.');

      for (const [roundNo, list] of collected) {
        const seen = new Set<number>();
        for (const [a, h] of list) {
          if (seen.has(a) || seen.has(h)) {
            throw new InputError(`A team appears twice in round ${roundNo}.`);
          }
          seen.add(a);
          seen.add(h);
        }
      }

      rounds = [...collected.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([round, matchups]) => ({ round, matchups }));
    }

    await saveSchedule(db, seasonId, rounds);
    await rebuildSnapshot(db, slug);
    await audit(db, actor.email, action === 'generate' ? 'schedule.generate' : 'schedule.save', {
      seasonId,
      entity: 'season',
      entityId: slug,
      detail: `${rounds.length} rounds`,
    });

    return seeOther(
      back,
      action === 'generate'
        ? `Generated ${rounds.length} rounds. Adjust any fixture below, then save.`
        : 'Schedule saved.',
    );
  });
};
