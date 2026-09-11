// roundHalfEven must match Python's round() exactly, because build.py's output is the
// parity target and Python rounds half-to-EVEN while JavaScript rounds half away from
// zero. The cases below are the real divergences found in the Season 1 data plus the
// classic traps.

import { describe, expect, it } from 'vitest';

import { r1, r2, r3, roundHalfEven } from '../src/lib/mssb/round.ts';

describe('roundHalfEven', () => {
  it('rounds exact ties to even, where JS would round away from zero', () => {
    // Every one of these appears in the Season 1 box scores as an ERA, WHIP or K/9.
    const cases: [number, number][] = [
      [10.125, 10.12],
      [1.125, 1.12],
      [5.625, 5.62],
      [1.625, 1.62],
      [0.125, 0.12],
    ];
    for (const [input, expected] of cases) {
      expect(r2(input), `${input}`).toBe(expected);
      // Confirm this is a case JS gets wrong, so the test is proving something.
      expect(Number(input.toFixed(2))).not.toBe(expected);
    }
  });

  it('rounds ties up when the preceding digit is odd', () => {
    expect(r2(1.875)).toBe(1.88);
    expect(r2(0.875)).toBe(0.88);
    expect(r2(2.375)).toBe(2.38);
  });

  it('rounds on the exact binary value, not the decimal literal', () => {
    // Neither of these is actually a tie, and they fall on opposite sides of one, which
    // is why a "detect .xx5 in the decimal string" shortcut cannot work:
    //   1.235 is really 1.2350000000000000976... -> above the tie, rounds up
    expect(r2(1.235)).toBe(1.24);
    //   2.675 is really 2.6749999999999998223... -> below the tie, rounds down
    expect(r2(2.675)).toBe(2.67);
    //   1.005 is really 1.0049999999999998934... -> below the tie, rounds down
    expect(r2(1.005)).toBe(1.0);
  });

  it('handles the half-integer classics', () => {
    expect(roundHalfEven(0.5, 0)).toBe(0);
    expect(roundHalfEven(1.5, 0)).toBe(2);
    expect(roundHalfEven(2.5, 0)).toBe(2);
    expect(roundHalfEven(3.5, 0)).toBe(4);
    expect(roundHalfEven(-2.5, 0)).toBe(-2);
    expect(roundHalfEven(-1.5, 0)).toBe(-2);
  });

  it('is symmetric about zero', () => {
    for (const v of [10.125, 1.235, 5.625, 0.875, 16.615384615384617]) {
      expect(roundHalfEven(-v, 2)).toBe(-roundHalfEven(v, 2));
    }
  });

  it('passes values through when there is nothing to do', () => {
    expect(r3(0)).toBe(0);
    expect(r2(7)).toBe(7);
    expect(r1(3.3)).toBe(3.3);
    expect(roundHalfEven(Number.NaN, 2)).toBeNaN();
    expect(roundHalfEven(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it('rounds innings pitched to one decimal as build.py did', () => {
    expect(r1(1 / 3)).toBe(0.3);
    expect(r1(2 / 3)).toBe(0.7);
    expect(r1(9 / 3)).toBe(3);
    expect(r1(7 / 3)).toBe(2.3);
  });

  it('rounds rate stats to three decimals as build.py did', () => {
    expect(r3(1 / 3)).toBe(0.333);
    expect(r3(2 / 3)).toBe(0.667);
    expect(r3(0.8)).toBe(0.8);
  });
});
