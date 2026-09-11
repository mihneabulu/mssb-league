// Faithful reimplementation of Python's round(float, ndigits).
//
// Why this file exists: build.py rounds every rate stat with Python's round(), which
// is round-half-to-EVEN, applied to the exact binary value of the double. JavaScript's
// toFixed() and Math.round() round half AWAY FROM ZERO. Outs-pitched divided by 3 makes
// exact dyadic rationals constantly, so exact .xx5 ties are common, not exotic — there
// are 12 of them in the first 14 games alone (ERA 10.125 -> Python 10.12, JS 10.13).
//
// Approximating this with toFixed() is subtly wrong: Python rounds the EXACT value of
// the double, and e.g. 1.235 is really 1.23499999999999998667..., which is not a tie at
// all. So we decompose the double into its exact (mantissa x 2^exponent) form and do the
// comparison in exact integer arithmetic with BigInt. No floating point in the decision.

const bits = new DataView(new ArrayBuffer(8));

/** Decompose a finite double into an exact value: sign * mantissa * 2^exponent. */
function decompose(x: number): { neg: boolean; mantissa: bigint; exponent: number } {
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);

  const neg = (hi & 0x80000000) !== 0;
  const rawExponent = (hi >>> 20) & 0x7ff;
  const rawMantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);

  // Subnormals have an implicit leading 0 and a fixed exponent; normals an implicit 1.
  return rawExponent === 0
    ? { neg, mantissa: rawMantissa, exponent: -1074 }
    : { neg, mantissa: rawMantissa | (1n << 52n), exponent: rawExponent - 1075 };
}

/**
 * Round `x` to `digits` decimal places using round-half-to-even, matching Python's
 * round() bit for bit for every value this codebase produces.
 */
export function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;

  const { neg, mantissa, exponent } = decompose(x);
  const scale = 10n ** BigInt(digits);

  // The exact value is  mantissa * 2^exponent, and we want it scaled by 10^digits:
  //   exponent >= 0 -> already an integer multiple, nothing to decide
  //   exponent <  0 -> a fraction numerator/denominator, decide by comparing 2*rem vs den
  let quotient: bigint;
  if (exponent >= 0) {
    quotient = mantissa * (1n << BigInt(exponent)) * scale;
  } else {
    const denominator = 1n << BigInt(-exponent);
    const numerator = mantissa * scale;
    quotient = numerator / denominator;
    const remainder = numerator - quotient * denominator;
    const twice = remainder * 2n;

    if (twice > denominator) {
      quotient += 1n;
    } else if (twice === denominator) {
      // Exact tie: round to even.
      if (quotient % 2n !== 0n) quotient += 1n;
    }
  }

  const result = Number(quotient) / Number(scale);
  return neg ? -result : result;
}

/** round(x, 3) — batting rates and win pct. */
export const r3 = (x: number): number => roundHalfEven(x, 3);
/** round(x, 2) — ERA, WHIP, K/9. */
export const r2 = (x: number): number => roundHalfEven(x, 2);
/** round(x, 1) — innings pitched. */
export const r1 = (x: number): number => roundHalfEven(x, 1);
