// A structural diff that reports the path of every mismatch, so a failing parity test
// says "teams[3].pitching.era: expected 2.51, got 2.5" instead of dumping two objects.

export type Diff = { path: string; expected: unknown; actual: unknown };

export function diff(expected: unknown, actual: unknown, path = ''): Diff[] {
  if (Object.is(expected, actual)) return [];

  const bothObjects =
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    expected !== null &&
    actual !== null;

  if (!bothObjects) return [{ path: path || '(root)', expected, actual }];

  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return [{ path: path || '(root)', expected, actual }];
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
    }
    return expected.flatMap((v, i) => diff(v, (actual as unknown[])[i], `${path}[${i}]`));
  }

  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
  return keys.flatMap((k) => diff(e[k], a[k], path ? `${path}.${k}` : k));
}

export function formatDiffs(diffs: Diff[], limit = 25): string {
  if (!diffs.length) return '';
  const shown = diffs
    .slice(0, limit)
    .map(
      (d) => `  ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
    )
    .join('\n');
  const more = diffs.length > limit ? `\n  ... and ${diffs.length - limit} more` : '';
  return `${diffs.length} value(s) differ:\n${shown}${more}`;
}
