// Round-trip test for the decoded-export path.
//
// Project Rio's "decoded" export replaces ids with names, and its name table disagrees
// with ours on colour variants: it renders BOTH charId 24 (Noki(B)) and charId 26
// (Noki(G)) as "Noki(G)". Flame Imp rosters 24, so any decoded Flame Imp game forces the
// resolve-by-elimination fallback — which is exactly the subtle path worth testing.
//
// Method: take each real raw game, synthesize the decoded export Rio would have produced
// from it, feed that through the ordinary upload path, and require the result to be
// identical to analyzing the raw file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCtimeAtOffset, RECORDING_TZ_OFFSET_MINUTES } from '../src/lib/mssb/decoded.ts';
import { analyzeUpload } from '../src/lib/mssb/ingest.ts';
import { CHARACTERS, STADIUMS } from '../src/lib/mssb/reference.ts';
import type { RioGame } from '../src/lib/mssb/rio.ts';
import { legacyContext, REPO_ROOT, walkJson } from './legacy-context.ts';

/** Rio's decoder collapses these colour variants onto one name. */
const DECODER_NAME = (charId: number): string => (charId === 24 ? 'Noki(G)' : CHARACTERS[charId]);

const CTIME_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CTIME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format epoch seconds as a ctime string in the recording zone, as Rio does. */
function toCtime(epochSeconds: number): string {
  const d = new Date((epochSeconds + RECORDING_TZ_OFFSET_MINUTES * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${CTIME_DAYS[d.getUTCDay()]} ${CTIME_MONTHS[d.getUTCMonth()]} ` +
    `${String(d.getUTCDate()).padStart(2, ' ')} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    `${d.getUTCFullYear()}`
  );
}

/** Turn a raw numeric game into the decoded export Rio would have written. */
function toDecoded(raw: RioGame): RioGame {
  const out: RioGame = JSON.parse(JSON.stringify(raw));
  delete out._ingest;

  out['Date - Start'] = toCtime(Number(raw['Date - Start']));
  out['Date - End'] = toCtime(Number(raw['Date - End']));
  out.StadiumID = STADIUMS[Number(raw.StadiumID)];
  out['Quitter Team'] = 'None';

  for (const key of Object.keys(out['Character Game Stats'])) {
    const entry = out['Character Game Stats'][key];
    entry.CharID = DECODER_NAME(Number(entry.CharID));
  }
  return out;
}

const files = walkJson(join(REPO_ROOT, 'results'));

describe('ctime parsing', () => {
  it('reads a ctime string at the recording offset (UTC-5)', () => {
    // 2026-07-03 18:31:00 at UTC-5 is 2026-07-03 23:31:00 UTC.
    expect(parseCtimeAtOffset('Fri Jul  3 18:31:00 2026')).toBe(Date.UTC(2026, 6, 3, 23, 31, 0) / 1000);
  });

  it('round-trips every real game timestamp', () => {
    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as RioGame;
      const start = Number(raw['Date - Start']);
      expect(parseCtimeAtOffset(toCtime(start)), file).toBe(start);
    }
  });
});

describe('decoded export round-trip', () => {
  const ctx = legacyContext();

  it('has games to test', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // A decoded export identifies players by name against the DRAFTED roster, so a game in
  // which a substitute played cannot round-trip: the substitute's name is not on the
  // roster and gets replaced by the drafted player it displaced. Split the corpus
  // accordingly — full fidelity where it is achievable, explicit warnings where it isn't.
  const exactRoster: string[] = [];
  const withSubstitute: string[] = [];
  for (const file of files) {
    const analyzed = analyzeUpload(readFileSync(file, 'utf8'), file.split('/').pop()!, ctx());
    (analyzed.away.exact && analyzed.home.exact ? exactRoster : withSubstitute).push(file);
  }

  for (const file of exactRoster) {
    const name = file.split('/').pop()!;

    it(`recovers identical data from a decoded ${name}`, () => {
      const rawText = readFileSync(file, 'utf8');
      const raw = JSON.parse(rawText) as RioGame;

      const fromRaw = analyzeUpload(rawText, name, ctx());
      const fromDecoded = analyzeUpload(
        JSON.stringify(toDecoded(raw)),
        `decoded.${name}`,
        ctx(),
      );

      expect(fromDecoded.wasDecoded).toBe(true);
      expect(fromRaw.wasDecoded).toBe(false);

      // The identification, the score, the venue and every box-score line must agree.
      expect(fromDecoded.away.name).toBe(fromRaw.away.name);
      expect(fromDecoded.home.name).toBe(fromRaw.home.name);
      expect(fromDecoded.playedAt).toBe(fromRaw.playedAt);
      expect(fromDecoded.stadiumId).toBe(fromRaw.stadiumId);
      expect(fromDecoded.awayScore).toBe(fromRaw.awayScore);
      expect(fromDecoded.homeScore).toBe(fromRaw.homeScore);
      expect(fromDecoded.boxscore).toEqual(fromRaw.boxscore);
    });
  }

  it('covers most of the corpus with exact rosters', () => {
    expect(exactRoster.length).toBeGreaterThan(files.length / 2);
  });

  for (const file of withSubstitute) {
    const name = file.split('/').pop()!;

    it(`flags, rather than hides, the substitute in a decoded ${name}`, () => {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as RioGame;
      const fromDecoded = analyzeUpload(JSON.stringify(toDecoded(raw)), `decoded.${name}`, ctx());

      // The substitute is unrecoverable, but the game must not sail through as clean:
      // it is held for review with an explanation naming the affected player.
      expect(fromDecoded.status).toBe('needs_review');
      const eliminations = fromDecoded.warnings.filter((w) => w.kind === 'elimination');
      expect(eliminations.length).toBeGreaterThan(0);
      expect(eliminations[0].message).toMatch(/substitute/i);

      // Scores and venue are still perfectly recoverable.
      const fromRaw = analyzeUpload(readFileSync(file, 'utf8'), name, ctx());
      expect(fromDecoded.awayScore).toBe(fromRaw.awayScore);
      expect(fromDecoded.homeScore).toBe(fromRaw.homeScore);
      expect(fromDecoded.playedAt).toBe(fromRaw.playedAt);
    });
  }

  it('resolves the ambiguous Noki variant by elimination', () => {
    // Find a game featuring Flame Imp, who roster charId 24 — the id Rio's decoder
    // renders under charId 26's name.
    const flameImpFile = files.find((f) => f.includes('flame-imp'));
    expect(flameImpFile, 'expected a Flame Imp game in the corpus').toBeDefined();

    const raw = JSON.parse(readFileSync(flameImpFile!, 'utf8')) as RioGame;
    const result = analyzeUpload(JSON.stringify(toDecoded(raw)), 'decoded.game.json', ctx());

    const eliminations = result.warnings.filter((w) => w.kind === 'elimination');
    expect(eliminations.length).toBeGreaterThan(0);
    expect(eliminations.some((w) => w.message.includes('Noki'))).toBe(true);

    // And despite the ambiguity, charId 24 still lands in the box score.
    const all = [...result.boxscore.away, ...result.boxscore.home].map((p) => p.charId);
    expect(all).toContain(24);
  });
});
