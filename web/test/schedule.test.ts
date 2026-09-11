// A generated schedule is the kind of thing that looks right and is quietly wrong —
// a team playing itself, a pair meeting three times, someone never hosting. These
// properties are checked rather than eyeballed.

import { describe, expect, it } from 'vitest';

import { doubleRoundRobin } from '../src/lib/admin/schedule.ts';

const pairKey = (a: number, b: number) => [a, b].sort((x, y) => x - y).join('v');

function analyse(teamIds: number[]) {
  const rounds = doubleRoundRobin(teamIds);
  const meetings = new Map<string, number>();
  const hosted = new Map<number, number>();
  const away = new Map<number, number>();
  const perPairHome = new Map<string, number[]>();

  for (const r of rounds) {
    const seenThisRound = new Set<number>();
    for (const [a, h] of r.matchups) {
      expect(a, 'a team cannot play itself').not.toBe(h);
      expect(seenThisRound.has(a), `team ${a} appears twice in round ${r.round}`).toBe(false);
      expect(seenThisRound.has(h), `team ${h} appears twice in round ${r.round}`).toBe(false);
      seenThisRound.add(a);
      seenThisRound.add(h);

      const key = pairKey(a, h);
      meetings.set(key, (meetings.get(key) ?? 0) + 1);
      perPairHome.set(key, [...(perPairHome.get(key) ?? []), h]);
      hosted.set(h, (hosted.get(h) ?? 0) + 1);
      away.set(a, (away.get(a) ?? 0) + 1);
    }
  }
  return { rounds, meetings, hosted, away, perPairHome };
}

describe('doubleRoundRobin', () => {
  it('is empty for fewer than two teams', () => {
    expect(doubleRoundRobin([])).toEqual([]);
    expect(doubleRoundRobin([1])).toEqual([]);
  });

  it('produces the shape Season 1 used: 6 teams, 10 rounds of 3', () => {
    const rounds = doubleRoundRobin([1, 2, 3, 4, 5, 6]);
    expect(rounds).toHaveLength(10);
    for (const r of rounds) expect(r.matchups).toHaveLength(3);
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  for (const size of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`has every pair meet exactly twice with ${size} teams`, () => {
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const { meetings } = analyse(ids);

      const expectedPairs = (size * (size - 1)) / 2;
      expect(meetings.size).toBe(expectedPairs);
      for (const [pair, count] of meetings) {
        expect(count, `pair ${pair} met ${count} times`).toBe(2);
      }
    });

    it(`gives each pair one home game each way with ${size} teams`, () => {
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const { perPairHome } = analyse(ids);
      for (const [pair, hosts] of perPairHome) {
        expect(new Set(hosts).size, `pair ${pair} hosted by ${hosts}`).toBe(2);
      }
    });

    it(`balances home and away for ${size} teams`, () => {
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const { hosted, away } = analyse(ids);
      for (const id of ids) {
        // Each team meets every other twice, once at home.
        expect(hosted.get(id)).toBe(size - 1);
        expect(away.get(id)).toBe(size - 1);
      }
    });
  }

  it('sits exactly one team out per round when the count is odd', () => {
    const ids = [1, 2, 3, 4, 5];
    const rounds = doubleRoundRobin(ids);
    for (const r of rounds) {
      const playing = new Set(r.matchups.flat());
      expect(playing.size).toBe(ids.length - 1);
    }
  });
});
