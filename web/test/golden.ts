// Bridging the golden fixture's shape to the current snapshot's.
//
// build.py's data.json is frozen, so where the port has deliberately changed how a value
// is *represented* — never what it is — the difference is reconciled here and named, in
// one place both parity tests use. Anything not listed here must still match exactly.

import type { SeasonSnapshot } from '../src/lib/mssb/types.ts';

/**
 * Leaderboards hold CharAgg keys; build.py's held character ids.
 *
 * In a season without duplicate characters a key IS the character id as a string, so
 * this is an exact inverse and the comparison keeps its full force: every id build.py
 * picked must still be picked, in the same order.
 */
export function asCharIds(
  leaders: SeasonSnapshot['leaders'],
): Record<string, Record<string, number[]>> {
  const board = (b: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(b).map(([k, keys]) => [k, keys.map(Number)]));
  return { batting: board(leaders.batting), pitching: board(leaders.pitching) };
}

/** Drop the key that build.py's character lines had no equivalent for. */
export function stripKeys(characters: SeasonSnapshot['characters']): unknown[] {
  return characters.map(({ key: _key, ...rest }) => rest);
}
