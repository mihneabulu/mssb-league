// Generating a double round-robin schedule.
//
// Uses the circle method: fix the first team, rotate the rest. With an odd number of
// teams one sits out each round, which is why a bye slot is inserted rather than
// special-casing the loop.
//
// The second half repeats the first with home and away swapped, so every pair meets
// exactly twice and each team hosts exactly once in each pairing.

export type GeneratedRound = {
  round: number;
  /** [awayTeamId, homeTeamId] — the order teams.json used and the order Rio reports. */
  matchups: [number, number][];
};

const BYE = -1;

export function doubleRoundRobin(teamIds: number[]): GeneratedRound[] {
  if (teamIds.length < 2) return [];

  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(BYE);

  const n = teams.length;
  const half = n / 2;
  const firstLeg: [number, number][][] = [];

  // `rotating` holds every team but the first, which stays pinned.
  let rotating = teams.slice(1);

  for (let r = 0; r < n - 1; r++) {
    const order = [teams[0], ...rotating];
    const matchups: [number, number][] = [];

    for (let i = 0; i < half; i++) {
      const a = order[i];
      const b = order[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      // Alternate who hosts by round, so no team is always the away side early on.
      matchups.push(r % 2 === 0 ? [a, b] : [b, a]);
    }

    firstLeg.push(matchups);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }

  const rounds: GeneratedRound[] = [];
  firstLeg.forEach((matchups, i) => rounds.push({ round: i + 1, matchups }));
  firstLeg.forEach((matchups, i) =>
    rounds.push({
      round: firstLeg.length + i + 1,
      // Reverse fixture: the away side of the first leg hosts the second.
      matchups: matchups.map(([away, home]) => [home, away] as [number, number]),
    }),
  );

  return rounds;
}
