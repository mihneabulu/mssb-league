# Mario Superstar Baseball League

Standings, schedule, teams, box scores and stat leaderboards for the league, built from
Project Rio stat files.

**Live at [mssbleague.com](https://mssbleague.com). Run it at
[mssbleague.com/admin](https://mssbleague.com/admin).**

## Running the league

No terminal, no checkout, nothing to install. Sign in at `/admin` with your email — Access
sends a one-time code — and everything is a form.

| To do this | Go here |
|---|---|
| Add games | **Upload** — drop in the `.json` files Project Rio saved, check what it worked out, save |
| Fix a game's teams, round or notes | **Games** |
| Start a new season | **Seasons** → *Start a new season* (copy teams from last season if you like) |
| Run the draft | **Seasons** → pick a season → a team's `n/9` link |
| Build the fixture list | **Seasons** → pick a season → *Open the schedule editor* → *Generate* |
| Download a backup | **Tools** |

Uploads are never applied straight away. Each file gets a row you can correct first, and
anything the parser is unsure about is flagged rather than guessed silently — a roster
that only partly matches, a game already recorded, a file from a decoded export, a game
played at the wrong stadium.

### How teams are worked out

Project Rio logs both managers under the same account, so a side is identified by its
drafted roster — the exact set of nine character ids. That is why the draft has to be
entered before games can be uploaded, and why a substitute makes a game show up as
"check this" rather than an exact match.

## How it is put together

```
web/                      the site: Astro on Cloudflare Workers
  src/lib/mssb/           stat pipeline — parsing, roster identification, aggregation
  src/lib/db/             D1 queries, snapshots, uploads, admin writes
  src/lib/auth/           Cloudflare Access JWT verification
  src/pages/[season]/     public pages, one tree for every season
  src/pages/admin/        the admin screens
  src/pages/api/admin/    the form handlers behind them
  migrations/             D1 schema, plus the Season 1 seed
  test/                   including the parity suite (see below)
teams.json, results/      Season 1's original inputs, kept as the parity fixture's source
legacy/                   the retired Python scripts, kept as provenance
backups/                  nightly export of everything, committed by CI
```

Each season is aggregated into a single JSON snapshot — about 11 KB gzipped — which is
recomputed on every change and served from one row. The edge cache key includes the
season's version, so a change makes the old cached pages unreachable rather than stale.

URLs are season-scoped (`/s1/schedule`) with `/` redirecting to the current season, so a
link shared today still shows the same games next year.

## The parity suite

`build.py` used to produce `web/src/data/data.json`. That file is frozen as
`web/test/fixtures/season-1.golden.json`, and the tests rebuild Season 1 from the raw
files — and again after a round trip through SQLite — and require every value to match:
all six team records and rates, all 54 character stat lines, every leaderboard and all 28
box-score sides.

It is the reason the port can be trusted, and it runs on every push. If you change
anything in `src/lib/mssb/`, this is what tells you whether you changed a stat.

Watch out for one thing in particular: Python's `round()` is half-to-even applied to the
exact binary value of a double, and JavaScript's is not. Outs-pitched ÷ 3 produces exact
`.xx5` values constantly — a dozen already occur in the first 14 games — so `round.ts`
reimplements Python's behaviour rather than approximating it.

## Working on the site

```sh
cd web
npm install
npm run db:reset      # local D1: apply migrations, seed Season 1
npm run preview       # build, then serve on http://localhost:8787 with real bindings
npm test              # parity suite and everything else
npm run typecheck     # tsc plus astro check (.astro files are not covered by tsc alone)
```

To reach `/admin` locally, put `DEV_BYPASS_AUTH="true"` in `web/.dev.vars` (untracked).
The bypass also requires a loopback caller, so it cannot apply to the deployed site.

`npm run dev` (`astro dev`) is currently broken — its workerd process exits before it is
ready. Use `npm run preview`, which runs the real Worker anyway. Note that `wrangler dev`
presents requests as arriving at `mssbleague.com`, so browser form posts from
`localhost:8787` are refused by the origin check; use the site itself to exercise forms.

## Deploying

Pushing to `main` runs the tests, then applies migrations and deploys the Worker.

Repository secrets it needs:

| Secret | What for |
|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | deploying the Worker and applying migrations |
| `LEAGUE_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | the nightly backup (an Access **service token**, allowed by a policy on the Access app) |

Without them the deploy and backup steps skip with a notice instead of failing.

## Notes

- **Backups matter more than they used to.** The git log was the backup — every game
  arrived as a commit. Now the database holds the only live copy, which is what
  `backups/` and the nightly job are for. The archived original uploads are *not* in that
  export; grab those from **Tools** if you need them.
- **Dry Bones** is the one uncertain character mapping — the colour variants look almost
  identical. If a portrait looks wrong, swap the files in `web/public/portraits/`.
- **Decoded exports** (files usually named `decoded.*`) name characters instead of
  numbering them, and Rio's name table disagrees with ours on some colour variants. They
  are converted on upload. If a substitute played in one, the substitute cannot be
  recovered — the upload is held for review and says so.
- Do not publish the original league Excel: its `Stats` sheet contains a live Google API
  key. Rotate it if it has ever been shared.
