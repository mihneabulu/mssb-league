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
- **Decoded exports**: Project Rio can emit a human-readable variant (files usually
  prefixed `decoded.`) where `CharID` is a character name, `StadiumID` is a stadium
  name, and the dates are ctime strings. `ingest.py` converts these back to the raw
  numeric shape on the way into `results/`, so `build.py` only ever sees one schema.
  Two caveats: the decoder's name table disagrees with ours on some color variants
  (it renders both Noki 24 and 26 as `Noki(G)`), so names are resolved against a
  single team's roster rather than globally; and decoded ctime strings carry no
  timezone, so they are read at UTC-5, the offset at which every raw file's
  `Date - End` matches the timestamp in its own filename. The `Events` log is left
  in decoded form (`build.py` does not read it) and the file is tagged `_ingest`.

- **Stadium names**: each team has a home `stadium` in `teams.json`, and `build.py` learns
  `StadiumID`→name from played games (every game is at the home team's stadium), warning on
  any conflict. All six are now confirmed: `0` Mario Stadium, `1` Bowser Castle, `2` Wario
  Palace, `3` Yoshi Park, `4` Peach Garden, `5` DK Jungle. Games at a non-home field would
  show a conflict warning — set the correct id in `teams.json` `stadiums.byId` if that
  happens.
- Do **not** publish the original league Excel — its `Stats` sheet contains a live Google
  API key. Rotate it if it has been shared.
- If deploying to a GitHub Pages subpath, set `site` and `base` in `web/astro.config.mjs`.
