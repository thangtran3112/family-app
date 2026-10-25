"""The list review (02o-b v1, pure): each candidate's move from its list price once the day has ended.

It looks past the playhead (the window end and the close), so `plan.end_day` computes it only after the day is over
and the API serves it only then. The list price is the price at the evaluating filter's cut (`screen.build_list`),
on the day's own share basis, so it compares with the raw 1-minute prices of the day.
"""

import statistics
from collections.abc import Mapping
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.core.calendar import session

_MINUTE = pd.Timedelta(minutes=1)


def _pct(price: float | None, base: float | None) -> float | None:
    if price is None or not base:
        return None
    value = (price / base - 1) * 100
    return None if np.isnan(value) else round(float(value), 2)


def candidate_move(
    candidate: dict[str, Any], minutes: pd.DataFrame | None, day: date, window_end: pd.Timestamp
) -> dict:
    """One candidate's outcome: its price at the window end and at the close, and its range from the open to the
    window end, each as a move from its list price. Nulls when the day has no minutes for the symbol."""
    list_price = candidate["list_price"]
    row: dict[str, Any] = {
        "symbol": candidate["symbol"],
        "list_price": list_price,
        "window_end_price": None,
        "move_pct": None,
        "close_price": None,
        "close_move_pct": None,
        "high_pct": None,
        "low_pct": None,
        "range_pct": None,
    }
    found = session("stock", day)
    if minutes is None or minutes.empty or found is None:
        return row
    regular = minutes[(minutes.index >= found.regular_open) & (minutes.index < found.regular_close)]
    upto = regular[regular.index + _MINUTE <= window_end]
    if not regular.empty:
        row["close_price"] = round(float(regular["close"].iloc[-1]), 4)
        row["close_move_pct"] = _pct(float(regular["close"].iloc[-1]), list_price)
    if not upto.empty:
        row["window_end_price"] = round(float(upto["close"].iloc[-1]), 4)
        row["move_pct"] = _pct(float(upto["close"].iloc[-1]), list_price)
        row["high_pct"] = _pct(float(upto["high"].max()), list_price)
        row["low_pct"] = _pct(float(upto["low"].min()), list_price)
        if row["high_pct"] is not None and row["low_pct"] is not None:
            row["range_pct"] = round(row["high_pct"] - row["low_pct"], 2)
    return row


def compute_review(
    candidates: list[dict[str, Any]],
    minutes: Mapping[str, pd.DataFrame | None],
    day: date,
    window_end: pd.Timestamp,
    picks: Mapping[str, str],
) -> dict[str, Any]:
    """The review: every candidate's move, ranked by absolute move from the list price, her picks (`traded`
    first, then `starred`) highlighted with their rank, and the Selection numbers.

    `picks` maps a symbol to `traded` or `starred`. The median is over every candidate that has a move."""
    rows = [candidate_move(c, minutes.get(c["symbol"]), day, window_end) for c in candidates]
    moved = sorted((r for r in rows if r["move_pct"] is not None), key=lambda r: (-abs(r["move_pct"]), r["symbol"]))
    rank = {r["symbol"]: i for i, r in enumerate(moved, start=1)}
    for r in rows:
        r["rank"] = rank.get(r["symbol"])
        r["picked"] = picks.get(r["symbol"])
    chosen = [r for r in rows if r["picked"] and r["move_pct"] is not None]
    chosen.sort(key=lambda r: (r["picked"] != "traded", r["rank"]))
    absolute = [abs(r["move_pct"]) for r in moved]
    return {
        "window_end": window_end,
        "of": len(moved),
        "rows": sorted(rows, key=lambda r: (r["rank"] is None, r["rank"] or 0, r["symbol"])),
        "selection": {
            "picks": [
                {"symbol": r["symbol"], "kind": r["picked"], "move_pct": r["move_pct"], "rank": r["rank"]}
                for r in chosen
            ],
            "median_abs_move_pct": round(statistics.median(absolute), 2) if absolute else None,
            "picks_avg_abs_move_pct": (
                round(sum(abs(r["move_pct"]) for r in chosen) / len(chosen), 2) if chosen else None
            ),
        },
    }
