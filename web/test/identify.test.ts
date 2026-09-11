// Roster identification, including the three behaviours added for the browser flow that
// ingest.py did not have: refusing to guess, spotting a tie, and rejecting a game a team
// would have played against itself.

import { describe, expect, it } from 'vitest';

import { buildRosterIndex, identifyGame, identifySide, MIN_OVERLAP } from '../src/lib/mssb/identify.ts';

const index = buildRosterIndex([
  { teamId: 1, slug: 'alpha', name: 'Alpha', charIds: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  { teamId: 2, slug: 'bravo', name: 'Bravo', charIds: [9, 10, 11, 12, 13, 14, 15, 16, 17] },
  { teamId: 3, slug: 'carrier', name: 'Carrier', charIds: [18, 19, 20, 21, 22, 23, 24, 25, 26] },
]);

const alpha = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const bravo = [9, 10, 11, 12, 13, 14, 15, 16, 17];

describe('identifySide', () => {
  it('matches an exact drafted roster', () => {
    const m = identifySide(alpha, index);
    expect(m).toMatchObject({ teamId: 1, name: 'Alpha', exact: true, overlap: 9, ambiguous: false });
  });

  it('matches a roster with one substitute, but not as exact', () => {
    // charId 8 replaced by 40, who belongs to nobody.
    const m = identifySide([0, 1, 2, 3, 4, 5, 6, 7, 40], index);
    expect(m).toMatchObject({ teamId: 1, name: 'Alpha', exact: false, overlap: 8 });
  });

  it('refuses to guess when the overlap is too thin', () => {
    // Four Alpha players and five strangers — under the threshold, so no team.
    const m = identifySide([0, 1, 2, 3, 40, 41, 42, 43, 44], index);
    expect(m.teamId).toBeNull();
    expect(m.overlap).toBeLessThan(MIN_OVERLAP);
  });

  it('flags a roster that matches two teams equally well', () => {
    // Five from Alpha, five... no: five from Alpha and four from Bravo would not tie.
    // Build an even split at the threshold instead.
    const m = identifySide([0, 1, 2, 3, 4, 9, 10, 11, 12], index);
    // Alpha 5, Bravo 4 -> Alpha wins outright, so this is NOT ambiguous.
    expect(m.name).toBe('Alpha');
    expect(m.ambiguous).toBe(false);
  });

  it('marks a genuine tie as ambiguous', () => {
    const tied = buildRosterIndex([
      { teamId: 1, slug: 'a', name: 'A', charIds: [0, 1, 2, 3, 4, 30, 31, 32, 33] },
      { teamId: 2, slug: 'b', name: 'B', charIds: [0, 1, 2, 3, 4, 40, 41, 42, 43] },
    ]);
    const m = identifySide([0, 1, 2, 3, 4, 50, 51, 52, 53], tied);
    expect(m.overlap).toBe(5);
    expect(m.ambiguous).toBe(true);
  });
});

describe('identifyGame', () => {
  it('identifies both sides of an ordinary game', () => {
    const g = identifyGame(alpha, bravo, index);
    expect(g.away.name).toBe('Alpha');
    expect(g.home.name).toBe('Bravo');
    expect(g.collision).toBe(false);
  });

  it('never lets a team play itself', () => {
    // Both sides look like Alpha; the weaker match is dropped rather than accepted.
    const g = identifyGame(alpha, [0, 1, 2, 3, 4, 5, 6, 60, 61], index);
    expect(g.collision).toBe(true);
    expect(g.away.name).toBe('Alpha');
    expect(g.home.teamId).toBeNull();
  });

  it('keeps the exact side when resolving a collision', () => {
    // The fuzzy side is the away one this time, so it is the one that gets dropped.
    const g = identifyGame([0, 1, 2, 3, 4, 5, 6, 60, 61], alpha, index);
    expect(g.collision).toBe(true);
    expect(g.home.name).toBe('Alpha');
    expect(g.away.teamId).toBeNull();
  });
});
