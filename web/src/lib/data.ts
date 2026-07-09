import raw from "../data/data.json";

export type Batting = {
  gp: number;
  ab: number;
  h: number;
  "1b": number;
  "2b": number;
  "3b": number;
  hr: number;
  rbi: number;
  bb: number;
  hbp: number;
  sf: number;
  so: number;
  sb: number;
  starHits: number;
  pa: number;
  tb: number;
  avg: number;
  obp: number;
  slg: number;
  ops: number;
};
export type Pitching = {
  gp: number;
  outs: number;
  bf: number;
  r: number;
  er: number;
  h: number;
  hr: number;
  bb: number;
  hbp: number;
  so: number;
  pitches: number;
  wasPitcher: number;
  ip: number;
  era: number;
  whip: number;
  k9: number;
};
export type RosterChar = {
  charId: number;
  name: string;
  captain: boolean;
  portrait: string;
};
export type Team = {
  name: string;
  slug: string;
  color: string;
  captainCharId: number;
  captainPortrait: string;
  stadium: string;
  roster: RosterChar[];
  record: {
    w: number;
    l: number;
    t: number;
    gp: number;
    rf: number;
    ra: number;
    diff: number;
    pct: number;
  };
  batting: Batting;
  pitching: Pitching;
  rank: number;
};
export type BoxPlayer = {
  charId: number;
  name: string;
  captain: boolean;
  batting: Batting;
  pitching: Pitching;
};
export type Game = {
  gameId: string;
  week: number | null;
  date: number;
  dateISO: string;
  stadiumId: number;
  innings: number;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  winner: string | null;
  boxscore: { away: BoxPlayer[]; home: BoxPlayer[] };
};
export type CharAgg = {
  charId: number;
  name: string;
  team: string;
  portrait: string;
  batting: Batting;
  pitching: Pitching;
};

export const data = raw as unknown as {
  season: { name: string; startDate: string; rounds: number };
  generatedAt: string;
  teams: Team[];
  standings: string[];
  games: Game[];
  schedule: { round: number; matchups: [string, string][] }[];
  characters: CharAgg[];
  leaders: { batting: Record<string, number[]>; pitching: Record<string, number[]> };
  characterNames: Record<string, string>;
  stadiums: { note?: string; names?: string[]; byId?: Record<string, string> };
};

const byName = new Map(data.teams.map((t) => [t.name, t]));
export const team = (name: string): Team => byName.get(name)!;
export const teamBySlug = (slug: string): Team => data.teams.find((t) => t.slug === slug)!;
export const portrait = (charId: number): string => `portraits/${charId}.png`;
export const charName = (charId: number): string =>
  data.characterNames[String(charId)] ?? `#${charId}`;

export function stadiumName(id: number): string {
  const named = data.stadiums?.byId?.[String(id)];
  return named ?? `Stadium ${id}`;
}

export const homeStadium = (teamName: string): string => team(teamName)?.stadium ?? "";

// Stat glossary — column key -> plain-English definition, grouped by table context.
export const STAT_INFO: Record<"batting" | "pitching" | "standings", Record<string, string>> = {
  batting: {
    ab: "At bats — plate appearances not counting walks, hit-by-pitch, or sacrifices.",
    h: "Hits — times reaching base on a batted ball (singles, doubles, triples, home runs).",
    hr: "Home runs.",
    rbi: "Runs batted in — runners that scored as a result of this batter.",
    bb: "Walks — reached base on four balls.",
    so: "Strikeouts.",
    sb: "Bases stolen.",
    avg: "Batting average — hits per at bat (H ÷ AB).",
    obp: "On-base percentage — how often the batter reaches base: (H+BB+HBP) ÷ (AB+BB+HBP+SF).",
    slg: "Slugging — total bases per at bat (TB ÷ AB).",
    ops: "On-base plus slugging (OBP + SLG) — overall hitting value.",
    pa: "Plate appearances.",
    tb: "Total bases (1 per single, 2 double, 3 triple, 4 home run).",
  },
  pitching: {
    ip: "Innings pitched (outs recorded ÷ 3).",
    era: "Earned run average — earned runs allowed per 9 innings (9 × ER ÷ IP). Lower is better.",
    whip: "Walks and hits per inning pitched — (H + BB) ÷ IP. Lower is better.",
    so: "Strikeouts recorded as a pitcher.",
    k9: "Strikeouts per 9 innings.",
    h: "Hits allowed.",
    bb: "Walks allowed.",
    hr: "Home runs allowed.",
    er: "Earned runs allowed.",
    r: "Runs allowed.",
  },
  standings: {
    w: "Wins.",
    l: "Losses.",
    pct: "Winning percentage — wins ÷ games decided.",
    rf: "Runs for — total runs scored.",
    ra: "Runs against — total runs allowed.",
    diff: "Run differential (runs for − runs against).",
  },
};

export const standingsTeams = (): Team[] => data.standings.map((n) => team(n));

export function teamGames(name: string): Game[] {
  return data.games.filter((g) => g.away === name || g.home === name);
}

export type ScheduledMatchup = { a: string; b: string; game?: Game };
export type ScheduledRound = { round: number; matchups: ScheduledMatchup[] };

// Assign played games to schedule slots in date order (double round-robin: each
// pair meets twice, so the earlier unused game fills the earlier round). The
// "current" round is the first one not yet fully played — i.e. once every game
// in a week is in, "now playing" advances to the next week.
export function scheduleWithResults(): {
  rounds: ScheduledRound[];
  currentRound: number;
  complete: boolean;
} {
  const used = new Set<string>();
  const rounds: ScheduledRound[] = data.schedule.map((rd) => ({
    round: rd.round,
    matchups: rd.matchups.map(([a, b]) => {
      const g = data.games
        .filter((x) => !used.has(x.gameId))
        .sort((x, y) => x.date - y.date)
        .find((x) => (x.away === a && x.home === b) || (x.away === b && x.home === a));
      if (g) used.add(g.gameId);
      return { a, b, game: g };
    }),
  }));
  const firstIncomplete = rounds.find((r) => r.matchups.some((m) => !m.game));
  const complete = !firstIncomplete && rounds.length > 0;
  const currentRound = firstIncomplete ? firstIncomplete.round : (rounds.at(-1)?.round ?? 1);
  return { rounds, currentRound, complete };
}

// Resolve a schedule matchup to a played game (if any). Returns actual home/away.
export function findGame(a: string, b: string, afterOf: Set<string>): Game | undefined {
  return data.games.find(
    (g) =>
      !afterOf.has(g.gameId) && ((g.away === a && g.home === b) || (g.away === b && g.home === a)),
  );
}

// pretty helpers
export const pct3 = (n: number) => (n === 1 ? "1.000" : n.toFixed(3).replace(/^0/, ""));
export const fix2 = (n: number) => n.toFixed(2);
export const withUrl = (p: string, base = import.meta.env.BASE_URL) =>
  (base.endsWith("/") ? base : base + "/") + p.replace(/^\//, "");
