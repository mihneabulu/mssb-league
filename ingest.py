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

Both Project Rio export flavors are accepted: the raw numeric one, and the
"decoded." one that spells out character and stadium names. Decoded files are
converted back to the numeric shape as they land in results/.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

FILENAME_RE = re.compile(r"^(?:decoded\.)?(?P<ts>\d{8}T\d{6})_.*_(?P<gid>\d+)\.json$")

# Project Rio also exports a human-readable "decoded" variant of the same game:
# ids are replaced by names ("Bowser" instead of 9, "DK Jungle" instead of 5) and
# the dates are ctime strings. Those files are normalized back to the raw numeric
# shape on ingest so results/ stays one consistent schema for build.py.
CTIME_FMT = "%a %b %d %H:%M:%S %Y"
# The recording PC is on UTC-5: every raw file's "Date - End" renders as the
# timestamp in its own filename exactly at that offset. Decoded ctime strings
# carry no zone, so they are read the same way.
RECORDING_TZ = timezone(timedelta(hours=-5))


def load_teams(path: Path) -> dict:
    data = json.loads(path.read_text())
    lookup = {}  # frozenset(charIds) -> team name
    slugs = {}  # name -> slug
    for team in data["teams"]:
        ids = frozenset(m["charId"] for m in team["roster"])
        lookup[ids] = team["name"]
        slugs[team["name"]] = team["slug"]
    return {
        "raw": data,
        "lookup": lookup,
        "slugs": slugs,
        "charNames": {int(k): v for k, v in data["characters"].items()},
        "stadiumIds": {v: int(k) for k, v in data["stadiums"]["byId"].items()},
    }


def is_decoded(game: dict) -> bool:
    """A decoded export names things instead of numbering them."""
    return not str(game["Date - Start"]).lstrip("-").isdigit()


def roster_chars(game: dict, side: str) -> list:
    """The side's 9 CharID values, as stored: ints (raw) or names (decoded)."""
    cgs = game["Character Game Stats"]
    return [cgs[f"{side} Roster {i}"]["CharID"] for i in range(9)]


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


def identify_by_name(chars: list[str], teams: dict) -> tuple[str, bool, list[int]]:
    """Identify a decoded side and turn its 9 character names back into ids.

    The decoder's name table does not always agree with ours on color variants
    (it renders both Noki 24 and Noki 26 as "Noki(G)"), so names are resolved
    against ONE team's roster rather than globally: pick the best-matching team,
    map the names it accounts for, then hand any leftover slots the roster ids
    nobody claimed. Returns (team_name, exact_match, ids).
    """
    best_name, best_ids, best_hits = None, None, -1
    for team_ids, name in teams["lookup"].items():
        hits = len({teams["charNames"][i] for i in team_ids} & set(chars))
        if hits > best_hits:
            best_name, best_ids, best_hits = name, team_ids, hits

    by_name = {teams["charNames"][i]: i for i in best_ids}
    ids = [by_name.get(c) for c in chars]
    leftover = sorted(set(best_ids) - {i for i in ids if i is not None})
    for slot, char_id in enumerate(ids):
        if char_id is None and leftover:
            ids[slot] = leftover.pop(0)
            print(
                f"       note: decoded name {chars[slot]!r} -> "
                f"{ids[slot]} ({teams['charNames'][ids[slot]]}) by elimination"
            )
    return best_name, set(ids) == set(best_ids), ids


def normalize_decoded(game: dict, teams: dict, sides: dict[str, list[int]]) -> None:
    """Rewrite a decoded game in place into the raw numeric shape build.py reads:
    epoch dates, numeric roster CharIDs, numeric StadiumID.

    "Events" is left in its decoded form - build.py does not read it, and its
    character names cannot always be disambiguated the way roster slots can.
    """
    for key in ("Date - Start", "Date - End"):
        stamp = datetime.strptime(game[key], CTIME_FMT).replace(tzinfo=RECORDING_TZ)
        game[key] = str(int(stamp.timestamp()))

    cgs = game["Character Game Stats"]
    for side, ids in sides.items():
        for slot, char_id in enumerate(ids):
            cgs[f"{side} Roster {slot}"]["CharID"] = char_id

    stadium = game["StadiumID"]
    if isinstance(stadium, str):
        if stadium not in teams["stadiumIds"]:
            raise SystemExit(
                f"error: stadium {stadium!r} has no id yet - add it to "
                f"teams.json stadiums.byId and re-run"
            )
        game["StadiumID"] = teams["stadiumIds"][stadium]

    if game.get("Quitter Team") in (None, "None"):
        game["Quitter Team"] = 255  # raw files use 255 for "nobody quit"

    game["_ingest"] = {"decodedSource": True, "eventsFormat": "decoded"}


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

    verb = "COPY" if copy else "MOVE"
    print(f"[{verb}] {src.name}")

    decoded = is_decoded(game)
    if decoded:
        print("       (decoded export - normalizing to the raw numeric format)")
        away_name, away_exact, away_ids = identify_by_name(roster_chars(game, "Away"), teams)
        home_name, home_exact, home_ids = identify_by_name(roster_chars(game, "Home"), teams)
        normalize_decoded(game, teams, {"Away": away_ids, "Home": home_ids})
    else:
        away_name, away_exact = identify(frozenset(roster_chars(game, "Away")), teams)
        home_name, home_exact = identify(frozenset(roster_chars(game, "Home")), teams)
    away_score, home_score = game["Away Score"], game["Home Score"]

    ts, gid = parse_source(src, game)
    week = week_for(game, teams["raw"]["season"]["startDate"], week_override)

    fname = f"{ts}_{teams['slugs'][away_name]}-vs-{teams['slugs'][home_name]}_{gid}.json"
    dest_dir = out_root / f"week-{week:02d}"
    dest = dest_dir / fname

    winner = (
        away_name if away_score > home_score else home_name if home_score > away_score else None
    )
    flag = "" if (away_exact and home_exact) else "  (fuzzy roster match!)"
    print(f"       {away_name} {away_score} @ {home_score} {home_name}  -> {winner or 'TIE'}{flag}")
    print(f"       week-{week:02d}/{fname}")

    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.resolve() != src.resolve():
            print(f"       WARNING: overwriting existing {dest}")
        if decoded:
            # Normalized in memory, so write the converted game rather than the file.
            dest.write_text(json.dumps(game, indent=2))
            if not copy:
                src.unlink()
        else:
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
