import type { APIRoute } from 'astro';

import { audit, failed, handle, InputError, seeOther, str } from '../../../../lib/admin/respond.ts';
import { deleteGame, updateGame } from '../../../../lib/db/admin.ts';
import { rebuildSnapshot } from '../../../../lib/db/snapshot.ts';
import { buildSeasonContext, gunzip } from '../../../../lib/db/uploads.ts';
import { analyzeUpload } from '../../../../lib/mssb/ingest.ts';

export const POST: APIRoute = async ({ request, params, locals }) => {
  const gameId = Number(params.id);
  const back = '/admin/games';

  return handle(back, async () => {
    const { db, actor } = locals;

    const rows = await db.all(
      `SELECT g.id, g.season_id, g.rio_game_id, g.raw_id, s.slug
       FROM games g JOIN seasons s ON s.id = g.season_id WHERE g.id = ?`,
      [gameId],
    );
    const game = rows[0];
    if (!game) return failed(back, 'That game no longer exists.');

    const seasonId = Number(game.season_id);
    const seasonSlug = String(game.slug);
    const form = await request.formData();
    const action = str(form, '_action');

    if (action === 'delete') {
      await deleteGame(db, gameId);
      await rebuildSnapshot(db, seasonSlug);
      await audit(db, actor.email, 'game.delete', {
        seasonId,
        entity: 'game',
        entityId: gameId,
        detail: String(game.rio_game_id),
      });
      return seeOther(back, 'Game deleted. The original file is still archived.');
    }

    if (action === 'reparse') {
      // Re-read the archived upload through the current parser. This is what makes a
      // parser fix retroactive without asking anyone to find the file again.
      const rawRows = await db.all(`SELECT bytes_gz, filename FROM game_raw WHERE id = ?`, [
        Number(game.raw_id),
      ]);
      if (!rawRows[0]) throw new InputError('The original file for this game was not kept.');

      const text = await gunzip(rawRows[0].bytes_gz);
      const ctx = await buildSeasonContext(db, seasonId);
      const a = analyzeUpload(text, String(rawRows[0].filename ?? 'archived.json'), ctx);
      if (a.status === 'error') throw new InputError(`Could not re-read it: ${a.error}`);

      // Teams and round are left alone on purpose — those are human decisions already
      // made. Only the parsed facts are refreshed.
      await db.run(
        `UPDATE games SET away_score = ?, home_score = ?, innings_played = ?, stadium_id = ?,
                          played_at = ?, ended_at = ?, box_json = ? WHERE id = ?`,
        [a.awayScore, a.homeScore, a.innings, a.stadiumId, a.playedAt, a.endedAt,
         JSON.stringify(a.boxscore), gameId],
      );
      await rebuildSnapshot(db, seasonSlug);
      await audit(db, actor.email, 'game.reparse', {
        seasonId,
        entity: 'game',
        entityId: gameId,
        detail: String(game.rio_game_id),
      });
      return seeOther(back, 'Re-read the original file and refreshed the stats.');
    }

    const away = Number(form.get('away'));
    const home = Number(form.get('home'));
    if (!away || !home) throw new InputError('Both teams are required.');

    // Both teams must belong to this game's season. Without this a stale page could
    // store a team id from another season; the write would succeed and every later
    // snapshot rebuild would then throw, leaving the season unviewable.
    const valid = await db.all(`SELECT id FROM teams WHERE season_id = ?`, [seasonId]);
    const ids = new Set(valid.map((t) => Number(t.id)));
    if (!ids.has(away) || !ids.has(home)) {
      throw new InputError('Those teams are not in this game\'s season. Reload and try again.');
    }

    const roundRaw = str(form, 'round');
    let roundId: number | null = null;
    if (roundRaw) {
      const r = await db.all(`SELECT id FROM rounds WHERE season_id = ? AND round_no = ?`, [
        seasonId,
        Number(roundRaw),
      ]);
      if (!r[0]) throw new InputError(`Round ${roundRaw} does not exist in this season.`);
      roundId = Number(r[0].id);
    }

    const notes = str(form, 'notes');
    await updateGame(db, gameId, {
      roundId,
      awayTeamId: away,
      homeTeamId: home,
      notes: notes || null,
    });
    await rebuildSnapshot(db, seasonSlug);
    await audit(db, actor.email, 'game.update', {
      seasonId,
      entity: 'game',
      entityId: gameId,
      detail: String(game.rio_game_id),
    });
    return seeOther(back, 'Game updated.');
  });
};
