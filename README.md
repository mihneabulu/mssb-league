# Mario Superstar Baseball League — tracking site

A static site for the league's standings, schedule, team pages, and stat leaderboards,
built from Project Rio stat files.

## How teams are identified

Every Project Rio game logs both managers as the same account (`Coqueza`), so teams are
identified by their **drafted roster** — the exact set of 9 character IDs. `teams.json`
holds every team's roster (plus colors, portraits, and the schedule) and is the single
source of truth reused by every script and by the site.

## Layout

```
teams.json              source of truth: teams, rosters, colors, schedule, char id->name
ingest.py               organize a raw Project Rio json into results/week-NN/
build.py                aggregate results/ -> web/src/data/data.json
assets/portraits/       54 character portraits (charId.png), extracted from the draft
results/week-NN/         renamed, organized game files
web/                    the Astro site
```

## Weekly workflow

1. Drop the new Project Rio `.json` files somewhere and ingest them (identifies teams,
   renames, files into `results/week-NN/`):

   ```sh
   uv run ingest.py path/to/*.json          # add --week N to force a week; --dry-run to preview
   ```

2. Rebuild the site data:

   ```sh
   uv run build.py --out web/src/data/data.json
   ```

3. Preview or publish:

   ```sh
   cd web
   npm install        # first time only
   npm run dev        # local preview at http://localhost:4321
   npm run build      # static output in web/dist/  -> deploy anywhere (e.g. GitHub Pages)
   ```

Both Python scripts use inline `uv` headers (PEP 723) and need only the standard library.

## Notes / TODO

- **Dry Bones portraits** are the only uncertain character mapping (color variants look
  near-identical): Oz's dark→`Dry Bones(B)` / light→`Dry Bones(R)`, Flame Imp's two
  greys→`Dry Bones(Gy)` / `(G)`. Swap the files in `assets/portraits/` + `web/public/portraits/`
  if any look wrong.
- **Stadium names**: each team has a home `stadium` in `teams.json`, and `build.py` learns
  `StadiumID`→name from played games (every game is at the home team's stadium), warning on
  any conflict. Confirmed so far: `0` Mario Stadium, `3` Yoshi Park, `5` DK Jungle. The
  remaining three IDs (Peach Garden, Wario Palace, Bowser Castle) fill in automatically once
  those teams host. Games at a non-home field would show a conflict warning — set the correct
  id in `teams.json` `stadiums.byId` if that happens.
- Do **not** publish the original league Excel — its `Stats` sheet contains a live Google
  API key. Rotate it if it has been shared.
- If deploying to a GitHub Pages subpath, set `site` and `base` in `web/astro.config.mjs`.
