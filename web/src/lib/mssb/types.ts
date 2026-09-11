// Shared domain types. The Batting/Pitching/BoxPlayer shapes are lifted verbatim from
// the old web/src/lib/data.ts so the built snapshot stays diff-compatible with the
// data.json that build.py produced.

export type Batting = {
  gp: number;
  ab: number;
  h: number;
  '1b': number;
  '2b': number;
  '3b': number;
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

/** A batting accumulator before rates are derived. */
export type BattingCounts = Omit<Batting, 'pa' | 'tb' | 'avg' | 'obp' | 'slg' | 'ops'>;
/** A pitching accumulator before rates are derived. */
export type PitchingCounts = Omit<Pitching, 'ip' | 'era' | 'whip' | 'k9'>;

export type RosterChar = {
  charId: number;
  name: string;
  captain: boolean;
  portrait: string;
};

export type TeamRecord = {
  w: number;
  l: number;
  t: number;
  gp: number;
  rf: number;
  ra: number;
  diff: number;
  pct: number;
};

export type Team = {
  name: string;
  slug: string;
  color: string;
  /** Null until the team has been drafted. */
  captainCharId: number | null;
  captainPortrait: string | null;
  stadium: string;
  roster: RosterChar[];
  record: TeamRecord;
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
  /**
   * Which scheduled round this game belongs to. Replaces the old `week`, which was a
   * filesystem filing convention derived from the calendar and had already drifted from
   * the schedule (a week-07 folder with no week-06, and a week-04 game predating a
   * week-03 one). Round is confirmed by a human at upload time and then stored.
   */
  round: number | null;
  date: number;
  dateISO: string;
  stadiumId: number;
  innings: number;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  winner: string | null;
  boxscore?: { away: BoxPlayer[]; home: BoxPlayer[] };
};

export type CharAgg = {
  charId: number;
  name: string;
  team: string | null;
  portrait: string;
  batting: Batting;
  pitching: Pitching;
};

export type ScheduleRound = {
  round: number;
  /** Each matchup is [away, home] — the order teams.json used, and the order Rio uses. */
  matchups: [string, string][];
};

export type SeasonMeta = {
  slug: string;
  name: string;
  shortLabel: string;
  startDate: string;
  rounds: number;
};

export type SeasonSnapshot = {
  season: SeasonMeta;
  generatedAt: string;
  teams: Team[];
  standings: string[];
  games: Game[];
  schedule: ScheduleRound[];
  characters: CharAgg[];
  leaders: {
    batting: Record<string, number[]>;
    pitching: Record<string, number[]>;
  };
  stadiums: { byId: Record<string, string> };
  stadiumWarnings: string[];
};

/** Everything buildSeasonSnapshot needs, independent of where it was loaded from. */
export type SeasonInput = {
  season: SeasonMeta;
  teams: {
    name: string;
    slug: string;
    color: string;
    captainCharId: number | null;
    captainPortrait: string | null;
    stadium: string;
    roster: RosterChar[];
  }[];
  schedule: ScheduleRound[];
  games: GameInput[];
};

export type GameInput = {
  gameId: string;
  round: number | null;
  date: number;
  stadiumId: number;
  innings: number;
  away: string;
  home: string;
  awayScore: number;
  homeScore: number;
  boxscore: { away: BoxPlayer[]; home: BoxPlayer[] };
};
