// URL building, in one place so a page never hardcodes a season into a href.
//
// Every season lives under its own prefix — /s1/schedule, /s2/schedule — and the bare
// domain redirects to whichever season is current.
//
// This differs from "current season at the root" on purpose: with the root approach a
// link to /teams/flame-imp shared during Season 1 would silently start showing Season 2
// data the moment the season rolled over. Prefixed URLs are permanent, which matters for
// a site whose whole job is a historical record.

export type Links = ReturnType<typeof makeLinks>;

export function makeLinks(seasonSlug: string) {
  const base = `/${seasonSlug}`;
  return {
    seasonSlug,
    home: base,
    schedule: `${base}/schedule`,
    teams: `${base}/teams`,
    team: (slug: string) => `${base}/teams/${slug}`,
    games: `${base}/games`,
    game: (gameId: string) => `${base}/games/${gameId}`,
    leaders: `${base}/leaders`,
    /** The same page in a different season, for the season switcher. */
    season: (slug: string) => `/${slug}`,
  };
}

/**
 * Path segments that can never be a season slug, because a real route already owns them.
 * Astro gives static routes priority over the dynamic [season] route, so a season named
 * "admin" would simply be unreachable rather than dangerous — but refusing the name up
 * front gives a clear error instead of a mystery.
 */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'portraits',
  '_astro',
  '_worker.js',
  'favicon.ico',
  'robots.txt',
  's',
]);

export const isValidSeasonSlug = (slug: string): boolean =>
  /^[a-z0-9][a-z0-9-]{0,30}$/.test(slug) && !RESERVED_SLUGS.has(slug);
