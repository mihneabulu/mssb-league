// Pure presentation helpers. No data dependency, so these stay ordinary module imports
// while everything season-specific moves onto Astro.locals.view.

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

/** ".500" / "1.000" — baseball convention drops the leading zero. */
export const pct3 = (n: number): string => (n === 1 ? '1.000' : n.toFixed(3).replace(/^0/, ''));

export const fix2 = (n: number): string => n.toFixed(2);

/** Portraits are plain static assets now that the GitHub Pages base path is gone. */
export const portrait = (charId: number): string => `/portraits/${charId}.png`;
