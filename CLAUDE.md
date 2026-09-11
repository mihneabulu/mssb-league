# Working in this repo

League site for Mario Superstar Baseball: Astro SSR on Cloudflare Workers, D1 for storage,
Cloudflare Access in front of `/admin`. All code lives in `web/`. See `README.md` for what
the site does and how the league is run.

## Commands

Run everything from `web/`.

```sh
npm test              # parity suite + unit tests — the gate, see below
npm run typecheck     # wrangler types && astro check && tsc --noEmit
npm run preview       # build, then serve the real Worker on :8787
npm run db:reset      # local D1: migrations + Season 1 seed
npm run import:legacy # regenerate migrations/seed/season-1.sql
```

`npm run dev` (`astro dev`) does not start — its workerd process exits before becoming
ready. Use `npm run preview`.

## The parity suite is the gate

`build.py` (now in `legacy/`) produced `web/test/fixtures/season-1.golden.json`.
`test/parity.test.ts` rebuilds Season 1 from the raw files, and `test/d1-roundtrip.test.ts`
does it again through SQLite, and both require every value to match.

If a change to `src/lib/mssb/` makes these fail, the stat output changed. **Fix the code,
not the test.** Only widen the explicit ignore-list for a deliberate, documented change.

## Traps

These have each already caused a bug. They are not obvious from reading the code.

- **Python rounds half-to-even; JavaScript does not.** Never use `toFixed`/`Math.round`
  for a stat — use `roundHalfEven` in `src/lib/mssb/round.ts`. Outs ÷ 3 hits exact `.xx5`
  ties constantly.
- **D1 returns BLOB columns as `number[]`,** not `ArrayBuffer`. Read them through
  `toBytes()` in `src/lib/db/uploads.ts`; passing the array to `new Response()` silently
  yields an empty body.
- **`tsc` does not check `.astro` files.** `npm run typecheck` runs `astro check` too —
  run it, not bare `tsc`. TypeScript is pinned to 6.x because `@astrojs/check` has no 7.x
  release.
- **`wrangler dev` rewrites the request URL to the configured custom domain.** A local
  request arrives claiming to be `mssbleague.com`, so hostname checks and browser form
  posts from `localhost:8787` behave differently than in production.
- **Remote D1 rejects `BEGIN TRANSACTION`/`COMMIT`** inside a file passed to
  `d1 execute --file`; local D1 accepts them. Seed files must not contain them.
- **A matchup is `[away, home]`.** The schedule page renders home first, which makes the
  data look reversed.
- **Service-token JWTs carry no `email` claim** — they have `common_name` and an empty
  `sub`. They are also restricted to safe HTTP methods.
- **Cloudflare strips `ETag`** from Worker responses on this plan, and a cached entry must
  be stored with a long `max-age` while the response returned to the browser keeps
  `max-age=0`. Storing the browser's headers disables the cache while appearing to work.

## Shape of the data

One row per season in `season_snapshots` holds the whole aggregate (34 KB stored, 5.6 KB
gzipped for Season 1). Public pages read only that row plus the season list. Box scores
live in `games.box_json` and are fetched per game.

## D1 limits that shape the code

50 queries per Worker invocation and 100 bound parameters per query. Bulk writes use
`db.batch()` and chunk their inserts (`chunkedInsert` in `src/lib/db/admin.ts`). A game's
box score is one JSON column rather than 18 rows for this reason.

## Conventions

- Imports use explicit `.ts` extensions so the same modules run under Node's type
  stripping in `scripts/` and `test/`.
- `src/lib/mssb/` is pure and dependency-free: no Cloudflare types, no I/O. Anything
  touching the database belongs in `src/lib/db/`.
- Admin screens are plain HTML forms that POST to `src/pages/api/admin/` and redirect.
  They must work with JavaScript disabled; JS only adds convenience.
- Every mutation calls `audit()` and then `rebuildSnapshot()`.
- Destructive actions refuse rather than proceed — deleting a season or team with games,
  or shrinking a schedule below rounds that have them.

## Deploying

Pushing to `main` runs tests, applies migrations and deploys. Do not commit
`web/.dev.vars` (local auth bypass) or `web/worker-configuration.d.ts` (generated).
