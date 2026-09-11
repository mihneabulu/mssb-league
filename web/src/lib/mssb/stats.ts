// Stat accumulators — a direct port of build.py's new_bat/new_pit/add_offense/
// add_defense/bat_rates/pit_rates. Field names and rounding match exactly so the
// snapshot stays diff-compatible with the data.json build.py produced.

import { r1, r2, r3 } from './round.ts';
import type { Batting, BattingCounts, Pitching, PitchingCounts } from './types.ts';

/** Project Rio's per-player offensive block. */
export type RioOffensive = {
  'At Bats': number;
  Hits: number;
  Singles: number;
  Doubles: number;
  Triples: number;
  Homeruns: number;
  RBI: number;
  'Walks (4 Balls)': number;
  'Walks (Hit)': number;
  'Sac Flys': number;
  Strikeouts: number;
  'Bases Stolen': number;
  'Star Hits': number;
};

/** Project Rio's per-player defensive block. */
export type RioDefensive = {
  'Was Pitcher': number;
  'Outs Pitched': number;
  'Batters Faced': number;
  'Runs Allowed': number;
  'Earned Runs': number;
  'Hits Allowed': number;
  'HRs Allowed': number;
  'Batters Walked': number;
  'Batters Hit': number;
  Strikeouts: number;
  'Pitches Thrown': number;
};

export function newBatting(): BattingCounts {
  return {
    gp: 0,
    ab: 0,
    h: 0,
    '1b': 0,
    '2b': 0,
    '3b': 0,
    hr: 0,
    rbi: 0,
    bb: 0,
    hbp: 0,
    sf: 0,
    so: 0,
    sb: 0,
    starHits: 0,
  };
}

export function newPitching(): PitchingCounts {
  return {
    gp: 0,
    outs: 0,
    bf: 0,
    r: 0,
    er: 0,
    h: 0,
    hr: 0,
    bb: 0,
    hbp: 0,
    so: 0,
    pitches: 0,
    wasPitcher: 0,
  };
}

export function addOffense(acc: BattingCounts, o: RioOffensive): void {
  acc.gp += 1;
  acc.ab += o['At Bats'];
  acc.h += o.Hits;
  acc['1b'] += o.Singles;
  acc['2b'] += o.Doubles;
  acc['3b'] += o.Triples;
  acc.hr += o.Homeruns;
  acc.rbi += o.RBI;
  acc.bb += o['Walks (4 Balls)'];
  acc.hbp += o['Walks (Hit)'];
  acc.sf += o['Sac Flys'];
  acc.so += o.Strikeouts;
  acc.sb += o['Bases Stolen'];
  acc.starHits += o['Star Hits'];
}

/** Only players who actually pitched contribute — a no-op otherwise, as in build.py. */
export function addDefense(acc: PitchingCounts, d: RioDefensive): void {
  if (!d['Was Pitcher']) return;
  acc.gp += 1;
  acc.wasPitcher += 1;
  acc.outs += d['Outs Pitched'];
  acc.bf += d['Batters Faced'];
  acc.r += d['Runs Allowed'];
  acc.er += d['Earned Runs'];
  acc.h += d['Hits Allowed'];
  acc.hr += d['HRs Allowed'];
  acc.bb += d['Batters Walked'];
  acc.hbp += d['Batters Hit'];
  acc.so += d.Strikeouts;
  acc.pitches += d['Pitches Thrown'];
}

export function battingRates(b: BattingCounts): Batting {
  const tb = b['1b'] + 2 * b['2b'] + 3 * b['3b'] + 4 * b.hr;
  const pa = b.ab + b.bb + b.hbp + b.sf;
  const obpDen = b.ab + b.bb + b.hbp + b.sf;
  const avg = b.ab ? b.h / b.ab : 0;
  const obp = obpDen ? (b.h + b.bb + b.hbp) / obpDen : 0;
  const slg = b.ab ? tb / b.ab : 0;
  return {
    ...b,
    pa,
    tb,
    avg: r3(avg),
    obp: r3(obp),
    slg: r3(slg),
    ops: r3(obp + slg),
  };
}

export function pitchingRates(p: PitchingCounts): Pitching {
  const ip = p.outs / 3;
  const era = ip ? (9 * p.er) / ip : 0;
  const whip = ip ? (p.h + p.bb) / ip : 0;
  const k9 = ip ? (9 * p.so) / ip : 0;
  return {
    ...p,
    ip: r1(ip),
    era: r2(era),
    whip: r2(whip),
    k9: r2(k9),
  };
}

/** Single-game batting line: a fresh accumulator with one game folded in. */
export function battingFor(o: RioOffensive): Batting {
  const acc = newBatting();
  addOffense(acc, o);
  return battingRates(acc);
}

/** Single-game pitching line: a fresh accumulator with one game folded in. */
export function pitchingFor(d: RioDefensive): Pitching {
  const acc = newPitching();
  addDefense(acc, d);
  return pitchingRates(acc);
}
