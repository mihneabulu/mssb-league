// The Project Rio stat-file format, and the small predicates ingest.py used to
// recognize and classify one.

import type { RioDefensive, RioOffensive } from './stats.ts';

export type RioRosterEntry = {
  /** Numeric in a raw export; a character NAME in a "decoded" export. */
  CharID: number | string;
  Captain: number | boolean;
  'Offensive Stats': RioOffensive;
  'Defensive Stats': RioDefensive;
};

export type RioGame = {
  GameID?: number | string;
  /** Epoch seconds in a raw export; a ctime string in a decoded export. */
  'Date - Start': number | string;
  'Date - End': number | string;
  /** Numeric in a raw export; a stadium NAME in a decoded export. */
  StadiumID: number | string;
  'Away Score': number;
  'Home Score': number;
  'Innings Selected'?: number;
  'Innings Played': number;
  'Quitter Team'?: number | string | null;
  'Character Game Stats': Record<string, RioRosterEntry>;
  Events?: unknown;
  _ingest?: { decodedSource: boolean; eventsFormat: string };
};

export type Side = 'Away' | 'Home';
export const SIDES: readonly Side[] = ['Away', 'Home'] as const;
/** Every team fields exactly nine characters. */
export const ROSTER_SIZE = 9;

/** The check ingest.py and build.py both used to skip non-stat files. */
export function isRioStatFile(x: unknown): x is RioGame {
  return (
    typeof x === 'object' &&
    x !== null &&
    'Character Game Stats' in x &&
    typeof (x as RioGame)['Character Game Stats'] === 'object'
  );
}

export type ParseResult =
  | { ok: true; game: RioGame }
  | { ok: false; error: string };

export function parseRioFile(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isRioStatFile(parsed)) {
    return { ok: false, error: 'not a Project Rio stat file (no "Character Game Stats")' };
  }
  return { ok: true, game: parsed };
}

/**
 * A decoded export names things instead of numbering them. ingest.py detected this by
 * checking whether "Date - Start" is a number; a ctime string like
 * "Fri Jul  3 18:31:00 2026" is not.
 */
export function isDecodedExport(game: RioGame): boolean {
  const start = String(game['Date - Start']);
  return !/^-?\d+$/.test(start);
}

/** The side's nine CharID values, as stored: numbers (raw) or names (decoded). */
export function rosterCharValues(game: RioGame, side: Side): (number | string)[] {
  const cgs = game['Character Game Stats'];
  const out: (number | string)[] = [];
  for (let i = 0; i < ROSTER_SIZE; i++) {
    const entry = cgs[`${side} Roster ${i}`];
    if (!entry) throw new Error(`missing roster slot "${side} Roster ${i}"`);
    out.push(entry.CharID);
  }
  return out;
}

export function rosterEntry(game: RioGame, side: Side, slot: number): RioRosterEntry {
  const entry = game['Character Game Stats'][`${side} Roster ${slot}`];
  if (!entry) throw new Error(`missing roster slot "${side} Roster ${slot}"`);
  return entry;
}

/**
 * Drop the Events log. It is ~96% of a 316 KB file, nothing reads it, and the decoded
 * variant leaves it in name form anyway. Kept out of anything we hold in memory or
 * aggregate; the full original still goes to game_raw.
 */
export function stripEvents(game: RioGame): RioGame {
  const { Events: _events, ...rest } = game;
  return rest as RioGame;
}
