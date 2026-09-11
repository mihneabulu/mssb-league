// Project Rio can emit a human-readable "decoded" export (files usually prefixed
// `decoded.`) where CharID is a character name, StadiumID is a stadium name, and the
// dates are ctime strings. This module converts one back to the raw numeric shape so
// everything downstream only ever sees one schema.
//
// Ported from ingest.py's identify_by_name() + normalize_decoded(). The quirks below are
// load-bearing and were each discovered the hard way — preserve them.

import { charName, stadiumIdByName } from './reference.ts';
import type { RioGame, Side } from './rio.ts';
import { ROSTER_SIZE, rosterEntry } from './rio.ts';
import type { RosterIndex } from './identify.ts';

/**
 * The recording PC is on UTC-5: every raw file's "Date - End" renders as the timestamp
 * in its own filename exactly at that offset. Decoded ctime strings carry no timezone,
 * so they are read the same way.
 */
export const RECORDING_TZ_OFFSET_MINUTES = -5 * 60;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse a ctime string ("Fri Jul  3 18:31:00 2026") at a fixed UTC offset, returning
 * epoch seconds. Python did this with strptime("%a %b %d %H:%M:%S %Y") + a tzinfo.
 */
export function parseCtimeAtOffset(
  s: string,
  offsetMinutes: number = RECORDING_TZ_OFFSET_MINUTES,
): number {
  // Day-of-month may be space-padded, hence the loose whitespace splitting.
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`unrecognized ctime string: ${JSON.stringify(s)}`);

  const month = MONTHS.indexOf(m[1]);
  if (month < 0) throw new Error(`unrecognized month in ctime string: ${JSON.stringify(s)}`);

  const utc = Date.UTC(
    Number(m[6]),
    month,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  // The parsed wall-clock is in the recording zone, so subtract the offset to get UTC.
  return Math.floor(utc / 1000) - offsetMinutes * 60;
}

export type DecodedSide = {
  teamId: number | null;
  name: string | null;
  exact: boolean;
  charIds: number[];
  notes: string[];
};

/**
 * Turn a decoded side's nine character NAMES back into ids.
 *
 * The decoder's name table does not always agree with ours on color variants — it
 * renders both charId 24 and charId 26 as "Noki(G)" — so names are resolved against ONE
 * team's roster rather than a global name->id map: pick the best-matching team, map the
 * names it accounts for, then hand any leftover slots the roster ids nobody claimed.
 */
export function resolveDecodedSide(names: string[], index: RosterIndex): DecodedSide {
  const wanted = new Set(names);

  let best: RosterIndex['teams'][number] | null = null;
  let bestHits = -1;
  for (const team of index.teams) {
    let hits = 0;
    for (const id of team.charIds) if (wanted.has(charName(id))) hits++;
    if (hits > bestHits) {
      best = team;
      bestHits = hits;
    }
  }

  if (!best) return { teamId: null, name: null, exact: false, charIds: [], notes: [] };

  const byName = new Map<string, number>();
  for (const id of best.charIds) byName.set(charName(id), id);

  // Each id may be claimed once. Rio's decoder renders some colour variants under a
  // single name (charId 24 and 26 both appear as "Noki(G)"), so a team holding both would
  // otherwise map both slots to the same id — duplicating one character's stats, losing
  // the other's, and reporting an exact match. Leaving the second slot unresolved sends
  // it through the elimination path below, which assigns the leftover id and says so.
  const claimedNames = new Set<number>();
  const charIds: (number | null)[] = names.map((n) => {
    const id = byName.get(n);
    if (id === undefined || claimedNames.has(id)) return null;
    claimedNames.add(id);
    return id;
  });

  const claimed = new Set(charIds.filter((v): v is number => v !== null));
  const leftover = [...best.charIds].filter((id) => !claimed.has(id)).sort((a, b) => a - b);

  const notes: string[] = [];
  for (let slot = 0; slot < charIds.length; slot++) {
    if (charIds[slot] === null && leftover.length) {
      const id = leftover.shift()!;
      charIds[slot] = id;
      notes.push(
        `Decoded name "${names[slot]}" is not on this team's drafted roster; ` +
          `assigned ${charName(id)} (#${id}) by elimination. If a substitute played, a ` +
          `decoded export cannot recover who — check this line against the game.`,
      );
    }
  }

  const resolved = charIds.filter((v): v is number => v !== null);
  const exact =
    resolved.length === names.length &&
    resolved.length === best.charIds.size &&
    resolved.every((id) => best!.charIds.has(id));

  return { teamId: best.teamId, name: best.name, exact, charIds: resolved, notes };
}

export type NormalizeResult = { game: RioGame; notes: string[] };

/**
 * Rewrite a decoded game into the raw numeric shape: epoch dates, numeric roster
 * CharIDs, numeric StadiumID.
 *
 * "Events" is deliberately left in its decoded form — nothing downstream reads it, and
 * its character names cannot always be disambiguated the way roster slots can.
 */
export function normalizeDecoded(
  game: RioGame,
  sides: Record<Side, number[]>,
): NormalizeResult {
  const notes: string[] = [];
  const out: RioGame = { ...game, 'Character Game Stats': { ...game['Character Game Stats'] } };

  for (const key of ['Date - Start', 'Date - End'] as const) {
    const value = out[key];
    if (typeof value === 'string' && !/^-?\d+$/.test(value)) {
      out[key] = String(parseCtimeAtOffset(value));
    }
  }

  for (const side of ['Away', 'Home'] as Side[]) {
    const ids = sides[side];
    for (let slot = 0; slot < ROSTER_SIZE; slot++) {
      const entry = { ...rosterEntry(out, side, slot) };
      entry.CharID = ids[slot];
      out['Character Game Stats'][`${side} Roster ${slot}`] = entry;
    }
  }

  if (typeof out.StadiumID === 'string') {
    const id = stadiumIdByName.get(out.StadiumID);
    if (id === undefined) {
      throw new Error(
        `stadium "${out.StadiumID}" has no known id — add it to reference.ts STADIUMS`,
      );
    }
    out.StadiumID = id;
  }

  // Raw files use 255 for "nobody quit".
  if (out['Quitter Team'] === null || out['Quitter Team'] === 'None') {
    out['Quitter Team'] = 255;
  }

  out._ingest = { decodedSource: true, eventsFormat: 'decoded' };
  return { game: out, notes };
}
