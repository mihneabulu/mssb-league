#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""
Ingest a Project Rio Mario Superstar Baseball stat file.

Every game is logged by Project Rio as "Coqueza-Vs-Coqueza" (both managers share
one account), so the real teams can only be identified by their *rosters* — the
set of 9 drafted CharIDs. This script reads teams.json (the source of truth for
who drafted whom), figures out which team is Away and which is Home, then copies
the file into a tidy, web-loadable tree:

    results/week-01/20260703T183100_booty-barn-vs-flame-imp_48054606.json

Usage:
    ./ingest.py game1.json game2.json ...          # move into results/
    ./ingest.py *.json --week 1                     # force a week number
    ./ingest.py game.json --copy --dry-run          # preview without touching
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import UTC, date, datetime
from pathlib import Path

FILENAME_RE = re.compile(r"^(?P<ts>\d{8}T\d{6})_.*_(?P<gid>\d+)\.json$")


def load_teams(path: Path) -> dict:
    data = json.loads(path.read_text())
    lookup = {}  # frozenset(charIds) -> team name
    slugs = {}  # name -> slug
    for team in data["teams"]:
        ids = frozenset(m["charId"] for m in team["roster"])
        lookup[ids] = team["name"]
        slugs[team["name"]] = team["slug"]
    return {"raw": data, "lookup": lookup, "slugs": slugs}


def roster_ids(game: dict, side: str) -> frozenset[int]:
    cgs = game["Character Game Stats"]
    return frozenset(cgs[f"{side} Roster {i}"]["CharID"] for i in range(9))


def identify(ids: frozenset[int], teams: dict) -> tuple[str, bool]:
    """Return (team_name, exact_match). Exact set match preferred; otherwise the
    team with the largest roster overlap (handles subbed-in backup characters)."""
    if ids in teams["lookup"]:
        return teams["lookup"][ids], True
    best_name, best_overlap = None, -1
    for team_ids, name in teams["lookup"].items():
        overlap = len(ids & team_ids)
        if overlap > best_overlap:
            best_name, best_overlap = name, overlap
    return best_name, False


def parse_source(src: Path, game: dict) -> tuple[str, str]:
    """Pull the display timestamp and game id, preferring the original filename
    and falling back to the JSON body."""
    m = FILENAME_RE.match(src.name)
    if m:
        return m.group("ts"), m.group("gid")
    ts = datetime.fromtimestamp(int(game["Date - Start"]), tz=UTC).strftime("%Y%m%dT%H%M%S")
    return ts, str(game.get("GameID", "unknown"))


def week_for(game: dict, season_start: str, override: int | None) -> int:
    if override is not None:
        return override
    start = date.fromisoformat(season_start)
    played = datetime.fromtimestamp(int(game["Date - Start"]), tz=UTC).date()
    return max(1, (played - start).days // 7 + 1)


def ingest_one(
    src: Path, teams: dict, out_root: Path, week_override: int | None, copy: bool, dry_run: bool
) -> dict:
    game = json.loads(src.read_text())
    if "Character Game Stats" not in game:
        print(f"skip: {src.name} is not a Project Rio stat file")
        return {}

    away_name, away_exact = identify(roster_ids(game, "Away"), teams)
    home_name, home_exact = identify(roster_ids(game, "Home"), teams)
    away_score, home_score = game["Away Score"], game["Home Score"]

    ts, gid = parse_source(src, game)
    week = week_for(game, teams["raw"]["season"]["startDate"], week_override)

    fname = f"{ts}_{teams['slugs'][away_name]}-vs-{teams['slugs'][home_name]}_{gid}.json"
    dest_dir = out_root / f"week-{week:02d}"
    dest = dest_dir / fname

    winner = (
        away_name if away_score > home_score else home_name if home_score > away_score else None
    )
    verb = "COPY" if copy else "MOVE"
    flag = "" if (away_exact and home_exact) else "  (fuzzy roster match!)"
    print(f"[{verb}] {src.name}")
    print(f"       {away_name} {away_score} @ {home_score} {home_name}  -> {winner or 'TIE'}{flag}")
    print(f"       week-{week:02d}/{fname}")

    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.resolve() != src.resolve():
            print(f"       WARNING: overwriting existing {dest}")
        (shutil.copy2 if copy else shutil.move)(str(src), str(dest))

    return {
        "gameId": gid,
        "timestamp": ts,
        "week": week,
        "away": away_name,
        "home": home_name,
        "awayScore": away_score,
        "homeScore": home_score,
        "winner": winner,
        "file": str(dest.relative_to(out_root.parent)),
        "exactMatch": away_exact and home_exact,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest & organize Project Rio MSB stat files.")
    ap.add_argument("files", nargs="+", type=Path, help="Raw .json stat file(s)")
    ap.add_argument("--teams", type=Path, default=Path("teams.json"))
    ap.add_argument(
        "--out", type=Path, default=Path("results"), help="Output root (default: results/)"
    )
    ap.add_argument(
        "--week", type=int, default=None, help="Force a week number instead of inferring from date"
    )
    ap.add_argument("--copy", action="store_true", help="Copy instead of move (keep originals)")
    ap.add_argument("--dry-run", action="store_true", help="Show what would happen; change nothing")
    args = ap.parse_args()

    if not args.teams.exists():
        print(f"error: {args.teams} not found", file=sys.stderr)
        return 1
    teams = load_teams(args.teams)

    for f in args.files:
        if not f.exists():
            print(f"skip: {f} not found", file=sys.stderr)
            continue
        ingest_one(f, teams, args.out, args.week, args.copy, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
