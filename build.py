#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""
Aggregate every ingested game under results/ into a single site/data.json that
the Astro front end consumes. Reuses teams.json as the source of truth for who
drafted whom, team colors, portraits, and the schedule.

    uv run build.py                 # -> site/data.json
    uv run build.py --out site/data.json --results results --teams teams.json

Stats computed per character (aggregated across all games), per team, and as
league leaderboards, including advanced rates (AVG/OBP/SLG/OPS, ERA/WHIP/K9).
"""

from __future__ import annotations

import argparse
import glob
import json
from datetime import UTC, datetime
from pathlib import Path


def load_teams(path: Path) -> dict:
    data = json.loads(path.read_text())
    lookup = {frozenset(m["charId"] for m in t["roster"]): t["name"] for t in data["teams"]}
    return data, lookup


def identify(ids: frozenset[int], lookup: dict) -> str:
    if ids in lookup:
        return lookup[ids]
    return max(lookup.items(), key=lambda kv: len(ids & kv[0]))[1]


def roster_ids(game: dict, side: str) -> frozenset[int]:
    cgs = game["Character Game Stats"]
    return frozenset(cgs[f"{side} Roster {i}"]["CharID"] for i in range(9))


# ---- stat accumulators -------------------------------------------------------


def new_bat() -> dict:
    return {
        k: 0
        for k in [
            "gp",
            "ab",
            "h",
            "1b",
            "2b",
            "3b",
            "hr",
            "rbi",
            "bb",
            "hbp",
            "sf",
            "so",
            "sb",
            "starHits",
        ]
    }


def new_pit() -> dict:
    return {
        k: 0
        for k in [
            "gp",
            "outs",
            "bf",
            "r",
            "er",
            "h",
            "hr",
            "bb",
            "hbp",
            "so",
            "pitches",
            "wasPitcher",
        ]
    }


def add_offense(acc: dict, o: dict) -> None:
    acc["gp"] += 1
    acc["ab"] += o["At Bats"]
    acc["h"] += o["Hits"]
    acc["1b"] += o["Singles"]
    acc["2b"] += o["Doubles"]
    acc["3b"] += o["Triples"]
    acc["hr"] += o["Homeruns"]
    acc["rbi"] += o["RBI"]
    acc["bb"] += o["Walks (4 Balls)"]
    acc["hbp"] += o["Walks (Hit)"]
    acc["sf"] += o["Sac Flys"]
    acc["so"] += o["Strikeouts"]
    acc["sb"] += o["Bases Stolen"]
    acc["starHits"] += o["Star Hits"]


def add_defense(acc: dict, d: dict) -> None:
    if not d.get("Was Pitcher"):
        return
    acc["gp"] += 1
    acc["wasPitcher"] += 1
    acc["outs"] += d["Outs Pitched"]
    acc["bf"] += d["Batters Faced"]
    acc["r"] += d["Runs Allowed"]
    acc["er"] += d["Earned Runs"]
    acc["h"] += d["Hits Allowed"]
    acc["hr"] += d["HRs Allowed"]
    acc["bb"] += d["Batters Walked"]
    acc["hbp"] += d["Batters Hit"]
    acc["so"] += d["Strikeouts"]
    acc["pitches"] += d["Pitches Thrown"]


def r3(x: float) -> float:
    return round(x, 3)


def bat_rates(b: dict) -> dict:
    ab, h, bb, hbp, sf = b["ab"], b["h"], b["bb"], b["hbp"], b["sf"]
    tb = b["1b"] + 2 * b["2b"] + 3 * b["3b"] + 4 * b["hr"]
    pa = ab + bb + hbp + sf
    obp_den = ab + bb + hbp + sf
    avg = h / ab if ab else 0.0
    obp = (h + bb + hbp) / obp_den if obp_den else 0.0
    slg = tb / ab if ab else 0.0
    return {
        **b,
        "pa": pa,
        "tb": tb,
        "avg": r3(avg),
        "obp": r3(obp),
        "slg": r3(slg),
        "ops": r3(obp + slg),
    }


def pit_rates(p: dict) -> dict:
    ip = p["outs"] / 3
    era = 9 * p["er"] / ip if ip else 0.0
    whip = (p["h"] + p["bb"]) / ip if ip else 0.0
    k9 = 9 * p["so"] / ip if ip else 0.0
    return {
        **p,
        "ip": round(ip, 1),
        "era": round(era, 2),
        "whip": round(whip, 2),
        "k9": round(k9, 2),
    }


# ---- main build --------------------------------------------------------------


def build(teams_path: Path, results_dir: Path, out_path: Path) -> dict:
    data, lookup = load_teams(teams_path)
    team_names = [t["name"] for t in data["teams"]]
    char_name = {int(k): v for k, v in data["characters"].items()}

    record = {n: {"w": 0, "l": 0, "t": 0, "rf": 0, "ra": 0} for n in team_names}
    team_bat = {n: new_bat() for n in team_names}
    team_pit = {n: new_pit() for n in team_names}
    char_bat = {c: new_bat() for c in range(54)}
    char_pit = {c: new_pit() for c in range(54)}
    char_team = {}
    for t in data["teams"]:
        for m in t["roster"]:
            char_team[m["charId"]] = t["name"]

    home_stadium = {t["name"]: t.get("stadium") for t in data["teams"]}
    # Learn StadiumID -> name: games are played at the home team's stadium.
    stadium_by_id = {int(k): v for k, v in data.get("stadiums", {}).get("byId", {}).items()}
    stadium_conflicts = []

    games = []
    files = sorted(glob.glob(str(results_dir / "**" / "*.json"), recursive=True))
    for fp in files:
        game = json.loads(Path(fp).read_text())
        if "Character Game Stats" not in game:
            continue
        cgs = game["Character Game Stats"]
        # Project Rio's Away/Home is correct: the home team bats last (bottom) and
        # the game is played at the home team's stadium (confirmed by game data —
        # a leading home team never bats in the bottom of the final inning).
        away = identify(roster_ids(game, "Away"), lookup)
        home = identify(roster_ids(game, "Home"), lookup)
        as_, hs = game["Away Score"], game["Home Score"]

        record[away]["rf"] += as_
        record[away]["ra"] += hs
        record[home]["rf"] += hs
        record[home]["ra"] += as_
        if as_ > hs:
            record[away]["w"] += 1
            record[home]["l"] += 1
            winner = away
        elif hs > as_:
            record[home]["w"] += 1
            record[away]["l"] += 1
            winner = home
        else:
            record[away]["t"] += 1
            record[home]["t"] += 1
            winner = None

        box = {"away": [], "home": []}
        for side, team in (("Away", away), ("Home", home)):
            for i in range(9):
                r = cgs[f"{side} Roster {i}"]
                cid = r["CharID"]
                add_offense(team_bat[team], r["Offensive Stats"])
                add_offense(char_bat[cid], r["Offensive Stats"])
                add_defense(team_pit[team], r["Defensive Stats"])
                add_defense(char_pit[cid], r["Defensive Stats"])
                box["away" if side == "Away" else "home"].append(
                    {
                        "charId": cid,
                        "name": char_name[cid],
                        "captain": bool(r["Captain"]),
                        "batting": bat_rates(new_bat() | _off(r["Offensive Stats"])),
                        "pitching": pit_rates(new_pit() | _def(r["Defensive Stats"])),
                    }
                )

        sid = game["StadiumID"]
        hs_name = home_stadium.get(home)
        if hs_name:
            if sid in stadium_by_id and stadium_by_id[sid] != hs_name:
                stadium_conflicts.append(
                    f"StadiumID {sid}: '{stadium_by_id[sid]}' vs '{hs_name}' "
                    f"(game {Path(fp).name}) — not played at home stadium?"
                )
            stadium_by_id[sid] = hs_name

        gid = Path(fp).name.rsplit("_", 1)[-1].removesuffix(".json")
        week = None
        parts = Path(fp).parent.name
        if parts.startswith("week-"):
            week = int(parts.split("-")[1])
        games.append(
            {
                "gameId": gid,
                "week": week,
                "date": int(game["Date - Start"]),
                "dateISO": datetime.fromtimestamp(int(game["Date - Start"]), tz=UTC).isoformat(),
                "stadiumId": game["StadiumID"],
                "innings": game["Innings Played"],
                "away": away,
                "home": home,
                "awayScore": as_,
                "homeScore": hs,
                "winner": winner,
                "boxscore": box,
                "file": str(Path(fp).relative_to(results_dir.parent)),
            }
        )

    games.sort(key=lambda g: g["date"])

    # standings: win % (ties count as half a win), then run diff per game, then
    # total run diff. Percentage/per-game bases keep ranking fair when teams have
    # played different numbers of games.
    def games_played(n: str) -> int:
        r = record[n]
        return r["w"] + r["l"] + r["t"]

    def win_pct(n: str) -> float:
        r = record[n]
        gp = games_played(n)
        return (r["w"] + 0.5 * r["t"]) / gp if gp else 0.0

    standings = sorted(
        team_names,
        key=lambda n: (
            win_pct(n),
            (record[n]["rf"] - record[n]["ra"]) / games_played(n) if games_played(n) else 0.0,
            record[n]["rf"] - record[n]["ra"],
        ),
        reverse=True,
    )

    teams_out = []
    for t in data["teams"]:
        n = t["name"]
        rec = record[n]
        teams_out.append(
            {
                **t,
                "record": {
                    **rec,
                    "gp": games_played(n),
                    "diff": rec["rf"] - rec["ra"],
                    "pct": r3(win_pct(n)),
                },
                "batting": bat_rates(team_bat[n]),
                "pitching": pit_rates(team_pit[n]),
                "rank": standings.index(n) + 1,
            }
        )

    characters_out = []
    for c in range(54):
        if char_bat[c]["gp"] == 0 and char_pit[c]["gp"] == 0:
            continue
        characters_out.append(
            {
                "charId": c,
                "name": char_name[c],
                "team": char_team.get(c),
                "portrait": f"portraits/{c}.png",
                "batting": bat_rates(char_bat[c]),
                "pitching": pit_rates(char_pit[c]),
            }
        )

    def top(items, key, n=10, mn_ab=None, mn_ip=None, reverse=True):
        pool = items
        if mn_ab is not None:
            pool = [i for i in pool if i["batting"]["ab"] >= mn_ab]
        if mn_ip is not None:
            pool = [i for i in pool if i["pitching"]["ip"] >= mn_ip]
        return [i["charId"] for i in sorted(pool, key=key, reverse=reverse)][:n]

    leaders = {
        "batting": {
            "avg": top(characters_out, lambda i: i["batting"]["avg"], mn_ab=3),
            "hr": top(characters_out, lambda i: i["batting"]["hr"]),
            "rbi": top(characters_out, lambda i: i["batting"]["rbi"]),
            "hits": top(characters_out, lambda i: i["batting"]["h"]),
            "ops": top(characters_out, lambda i: i["batting"]["ops"], mn_ab=3),
            "sb": top(characters_out, lambda i: i["batting"]["sb"]),
        },
        "pitching": {
            "era": top(characters_out, lambda i: i["pitching"]["era"], mn_ip=1, reverse=False),
            "so": top(characters_out, lambda i: i["pitching"]["so"]),
            "whip": top(characters_out, lambda i: i["pitching"]["whip"], mn_ip=1, reverse=False),
            "k9": top(characters_out, lambda i: i["pitching"]["k9"], mn_ip=1),
        },
    }

    out = {
        "season": data["season"],
        "generatedAt": datetime.now(UTC).isoformat(),
        "teams": teams_out,
        "standings": standings,
        "games": games,
        "schedule": data["schedule"],
        "characters": characters_out,
        "leaders": leaders,
        "characterNames": data["characters"],
        "stadiums": {
            **data.get("stadiums", {}),
            "byId": {str(k): stadium_by_id[k] for k in sorted(stadium_by_id)},
        },
        "stadiumConflicts": stadium_conflicts,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2))
    return out


def _off(o: dict) -> dict:
    a = new_bat()
    add_offense(a, o)
    return a


def _def(d: dict) -> dict:
    a = new_pit()
    add_defense(a, d)
    return a


def main() -> int:
    ap = argparse.ArgumentParser(description="Aggregate results/ into site/data.json")
    ap.add_argument("--teams", type=Path, default=Path("teams.json"))
    ap.add_argument("--results", type=Path, default=Path("results"))
    ap.add_argument("--out", type=Path, default=Path("web/src/data/data.json"))
    args = ap.parse_args()
    out = build(args.teams, args.results, args.out)
    print(
        f"Built {args.out}: {len(out['games'])} games, "
        f"{len(out['teams'])} teams, {len(out['characters'])} characters."
    )
    print("Standings:", " > ".join(out["standings"]))
    known = out["stadiums"]["byId"]
    print(f"Stadiums known: {len(known)}/6 -> " + ", ".join(f"{k}={v}" for k, v in known.items()))
    for w in out["stadiumConflicts"]:
        print("  ! stadium conflict:", w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
