"""Evaluate a filter spec over a set of symbols at the last closed bar (02m §b1 `screener/evaluator.py`).

The rules are `core/evaluate.py`'s: the same operand, level and condition code runs the filter's `when`, and a
filter reads closed bars only. The shape is the Run 0 snapshot's (`temp/desk-desktop-mvp/snapshot.py`,
`screen_one`), which is the oracle:

- a symbol matches when its condition is true at its last evaluation point;
- `matched_since` is the start of the unbroken run of true points ending there (an intraday cadence counts
  from the start of that day, so a daily-only fact cannot claim an earlier day);
- a symbol whose last evaluation point is on an earlier day than the newest one in the set, or that has no
  bars the cadence needs, is `no_data`, not a non-match;
- the liquidity floor is read from the symbol's own daily bars and removes a symbol from the scan entirely.

This module imports `core.evaluate`'s underscore helpers on purpose: they are the one implementation of operands
and conditions, and a second copy would drift. `tests/test_screener_evaluator.py` fails if they are renamed.
"""

import logging
import math
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import pandas as pd

from ai_trading.core import evaluate as engine
from ai_trading.core.calendar import ET, annotate, session

log = logging.getLogger(__name__)

DAILY_RUN_ON = ("daily_close", "weekly")
DEFAULT_AVG_VOLUME_DAYS = 20
_INTRADAY_ONLY = {"vwap"} | engine._SESSION_LEVELS | engine._OPENING_LEVELS
_UNSUPPORTED_LEVELS = engine._UNSUPPORTED_LEVELS


def check_filter(spec: dict[str, Any]) -> list[str]:
    """Plain-English reasons a dumped `FilterStrategySpecV1` cannot run, beyond what the schema says: an
    operand its cadence cannot compute, or a contract feature no engine path executes yet. [] when it can."""
    run_on = spec["watch"]["runOn"]
    when = spec["when"]
    operands = list(engine._operands(when))
    if spec.get("rank"):
        operands.append(spec["rank"]["by"])
    problems = []
    for operand in operands:
        name = operand.get("series") or operand["level"]
        if run_on not in engine.INTRADAY_CADENCES and name in _INTRADAY_ONLY:
            problems.append(f"{name} needs intraday bars; {run_on} uses daily bars")
        if run_on == "premarket_0830" and name in _INTRADAY_ONLY:
            problems.append(f"{name} is not known at 08:30 ET")
    nodes = list(engine._nodes(when))
    if run_on not in engine.INTRADAY_CADENCES and any(n.get("op") == "time_between" for n in nodes):
        problems.append(f"time_between needs intraday bars; {run_on} uses daily bars")
    if any(n.get("op") == "pattern" for n in nodes):
        problems.append("the pattern condition is not supported by the screener yet")
    problems += [
        f"{name} is not supported by the screener yet"
        for name in sorted({op["level"] for op in operands if op.get("level") in _UNSUPPORTED_LEVELS})
    ]
    return problems


@dataclass(frozen=True)
class SymbolBars:
    """Closed bars for one symbol: regular-session daily bars indexed by trading day, and 1-minute bars
    (extended hours included) indexed by UTC bar start, or None when none are stored."""

    daily: pd.DataFrame
    minutes: pd.DataFrame | None = None


@dataclass(frozen=True)
class Match:
    symbol: str
    evaluation_point: pd.Timestamp
    matched_since: pd.Timestamp
    rank_value: float | None
    operands: dict[str, float | None]


@dataclass
class ScanResult:
    """`matches` is ranked and capped at `maxResults`; `matches_total` counts every match before the cap.
    `truncated` is true when a deadline stopped the scan early, so the totals are partial."""

    evaluation_point: pd.Timestamp | None = None
    scanned: int = 0
    no_data: int = 0
    matches_total: int = 0
    matches: list[Match] = field(default_factory=list)
    truncated: bool = False


def _finite(value: object, digits: int = 6) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(number) or math.isinf(number)) else round(number, digits)


def passes_liquidity(daily: pd.DataFrame, liquidity: Mapping[str, Any] | None) -> bool:
    """The filter's own floor against the symbol's daily bars: last close and mean volume of the last
    `avgVolumeDays` (default 20) sessions. No `liquidity` block means no floor."""
    if not liquidity:
        return True
    if daily.empty:
        return False
    days = liquidity.get("avgVolumeDays") or DEFAULT_AVG_VOLUME_DAYS
    min_price, min_volume = liquidity.get("minPrice"), liquidity.get("minAvgVolume")
    if min_price is not None and float(daily["close"].iloc[-1]) < min_price:
        return False
    return min_volume is None or float(daily["volume"].iloc[-days:].mean()) >= min_volume


class Frames:
    """One symbol's evaluation frames for one `as_of`, built on demand and kept, so the filters of a pass share
    the annotated minutes and each resampled cadence."""

    def __init__(self, bars: SymbolBars, as_of: pd.Timestamp) -> None:
        self._as_of = as_of
        self._daily = self._closed_daily(bars.daily, as_of)
        self._minutes = bars.minutes
        self._annotated: pd.DataFrame | None = None
        self._frames: dict[str, engine._Frame | None] = {}

    @staticmethod
    def _closed_daily(daily: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
        keep = [
            day for day in daily.index if (found := session("stock", day)) is not None and found.regular_close <= as_of
        ]
        return daily.loc[keep].sort_index()

    @property
    def daily(self) -> pd.DataFrame:
        return self._daily

    def get(self, run_on: str) -> "engine._Frame | None":
        if run_on not in self._frames:
            self._frames[run_on] = self._build(run_on)
        return self._frames[run_on]

    def _build(self, run_on: str) -> "engine._Frame | None":
        if self._daily.empty:
            return None
        if run_on in DAILY_RUN_ON:
            return engine._Frame(self._daily, self._daily.index, self._daily, "stock", intraday=False)
        if self._annotated is None:
            minutes = self._minutes
            if minutes is None or minutes.empty:
                return None
            closed = minutes[minutes.index + pd.Timedelta(minutes=1) <= self._as_of].sort_index()
            self._annotated = annotate(closed, "stock")
        ann = self._annotated
        if ann.empty:
            return None
        bars = (
            engine._resample(ann, "stock", engine.CADENCE_MINUTES[run_on], self._as_of)
            if run_on in engine.CADENCE_MINUTES
            else ann
        )
        if bars.empty:
            return None
        return engine._Frame(bars, pd.Index(bars["day"]), self._daily, "stock", intraday=True)


def _point_day(point: pd.Timestamp) -> date:
    return point.tz_convert(ET).date()


@dataclass(frozen=True)
class _Outcome:
    symbol: str
    last_point: pd.Timestamp
    match: Match | None


def evaluate_symbol(spec: dict[str, Any], symbol: str, frames: Frames, as_of: pd.Timestamp) -> _Outcome | None:
    """None when the symbol has no bars the cadence needs; otherwise its state at its last evaluation point."""
    run_on = spec["watch"]["runOn"]
    frame = frames.get(run_on)
    if frame is None:
        return None
    truth = engine._condition(spec["when"], frame)
    points = engine._points(run_on, frame, spec["watch"]["session"], as_of)
    if points.empty:
        return None
    rows = pd.Index(points.to_numpy())
    now = truth.reindex(rows)
    now.index = points.index
    last_point = points.index[-1]
    state = now.iloc[-1]
    if pd.isna(state) or not bool(state):
        return _Outcome(symbol, last_point, None)

    flags = now.fillna(False).astype(bool).to_numpy()
    start = len(flags) - 1
    while start >= 0 and flags[start]:
        start -= 1
    start += 1
    if run_on not in DAILY_RUN_ON:
        last_day = _point_day(last_point)
        while _point_day(points.index[start]) != last_day:
            start += 1
    operands = {
        engine.label(operand): _finite(engine._series(operand, frame).reindex(rows).iloc[-1])
        for operand in engine._operands(spec["when"])
    }
    rank = spec.get("rank")
    rank_value = _finite(engine._series(rank["by"], frame).reindex(rows).iloc[-1]) if rank else None
    return _Outcome(symbol, last_point, Match(symbol, last_point, points.index[start], rank_value, operands))


def _ranked(matches: list[Match], rank: Mapping[str, Any] | None) -> list[Match]:
    descending = rank is None or rank["order"] == "desc"
    sign = -1.0 if descending else 1.0
    return sorted(matches, key=lambda m: (m.rank_value is None, sign * (m.rank_value or 0.0), m.symbol))


def scan(
    spec: dict[str, Any],
    data: Mapping[str, SymbolBars],
    as_of: pd.Timestamp,
    *,
    frames_for: Callable[[str, SymbolBars], Frames] | None = None,
    deadline: float | None = None,
) -> ScanResult:
    """Run `spec` over `data` (symbol to bars) as of `as_of`. `frames_for` lets a caller that runs several
    filters share each symbol's `Frames`; `deadline` is a `time.monotonic()` instant after which the scan
    stops and reports `truncated` (the preview's budget)."""
    make_frames = frames_for or (lambda _symbol, bars: Frames(bars, as_of))
    liquidity = spec.get("liquidity")
    outcomes: list[_Outcome] = []
    no_data = 0
    result = ScanResult()
    for symbol, bars in data.items():
        if deadline is not None and time.monotonic() > deadline:
            result.truncated = True
            break
        frames = make_frames(symbol, bars)
        if not passes_liquidity(frames.daily, liquidity):
            continue
        try:
            outcome = evaluate_symbol(spec, symbol, frames, as_of)
        except Exception as exc:  # one symbol's odd bars must not sink the pass; it reads as no_data
            log.warning("screener: %s could not be evaluated (%s)", symbol, type(exc).__name__)
            outcome = None
        if outcome is None:
            no_data += 1
        else:
            outcomes.append(outcome)

    if outcomes:
        newest = max(_point_day(o.last_point) for o in outcomes)
        current = [o for o in outcomes if _point_day(o.last_point) == newest]
        no_data += len(outcomes) - len(current)
        result.evaluation_point = max(o.last_point for o in current)
        matches = [o.match for o in current if o.match is not None]
        result.scanned = len(current)
        result.matches_total = len(matches)
        result.matches = _ranked(matches, spec.get("rank"))[: spec["maxResults"]]
    result.no_data = no_data
    return result
