# Superseded scripts

`ingest.py` and `build.py` ran the league from a laptop: they organised Project Rio
exports into `results/week-NN/` and aggregated them into `web/src/data/data.json`, which
the static site was built from.

They are no longer used. Their logic lives in `web/src/lib/mssb/`, which runs in the
Worker so that anyone — not just whoever had the repo checked out — can add a game.

**They are kept, unmodified, as provenance.** `web/test/fixtures/season-1.golden.json` is
the last `data.json` `build.py` ever produced, and `web/test/parity.test.ts` holds the
TypeScript port to it value for value. That test is the only independent check that the
port is faithful, so these files explain where its expected output came from.

Do not run them. `build.py` writes to `web/src/data/data.json`, a path nothing reads any
more, and re-running `ingest.py` would move files that are now seeded into D1.

If you ever need to check the port against Python again:

```sh
cd ..
uv run legacy/build.py --out /tmp/check.json
# then diff /tmp/check.json against web/test/fixtures/season-1.golden.json
```

The inputs they need — `teams.json` and `results/` — are deliberately still in the repo
for the same reason.
