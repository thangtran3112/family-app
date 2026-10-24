"""`/api/desk/charts*` (02m §a3.3): chart markers.

Patterns are `core/patterns.py` detections on the stored closed bars of the symbol's timeframe: the bars the alert
runtime and the screener read, resampled from stored 1-minute bars the way `core/evaluate.py` builds a cadence's
bars, regular session only (a candle never sits in extended hours). By default only the patterns her strategies
use are detected, each with that strategy's own trend rule, so a marker is where the strategy's condition
completes; `all_patterns=true` detects every catalog pattern with its template's rule. Fires are the signals her
strategies wrote for the symbol. A symbol with no stored bars (one on no watchlist) has no pattern markers; the
chart itself still reads its bars from the provider. `DESK_MVP_STUB=1` answers from the snapshot instead.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.bars import Interval, utc_datetime
from ai_trading.api.market_data import _MAX_SOURCE_DAYS, _weekly_bars, validate_symbol
from ai_trading.api.schemas.market import FireMarkerOut, MarkersOut, PatternMarkerOut
from ai_trading.core import patterns
from ai_trading.core.calendar import annotate
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.evaluate import _nodes, _resample
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Signal, Strategy, StrategyVersion
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.mvp_stub import market as stub_market
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/charts", tags=["charts"], dependencies=[Depends(get_current_user)])

_BAR_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240}
#: Calendar days shown when the caller gives no `from`.
_DEFAULT_DAYS = {"1m": 2, "5m": 5, "15m": 10, "30m": 20, "1h": 45, "4h": 90, "1d": 365, "1w": 1095}
#: Calendar days of bars read before `from`: enough for a three-candle pattern and its trend rule.
_LEAD_IN_DAYS = {"1d": 60, "1w": 260}
_INTRADAY_LEAD_IN_DAYS = 7


@dataclass(frozen=True)
class Rule:
    """One pattern to detect and the trend rule its marker is judged by."""

    pattern: str
    trend: str | None = None
    trend_bars: int = patterns.DEFAULT_TREND_BARS

    @classmethod
    def of(cls, node: dict[str, Any]) -> "Rule":
        return cls(node["pattern"], node.get("trend"), node.get("trendBars", patterns.DEFAULT_TREND_BARS))


def strategy_rules(session: Session, user_id: int) -> list[Rule]:
    """The pattern conditions in her current strategy versions (archived ones excluded), without repeats."""
    specs = session.execute(
        select(StrategyVersion.spec)
        .join(Strategy, Strategy.current_version_id == StrategyVersion.id)
        .where(Strategy.owner_user_id == user_id, Strategy.archived_at.is_(None), Strategy.lane == "technical")
    ).scalars()
    return list(
        dict.fromkeys(
            Rule.of(node)
            for spec in specs
            if isinstance(spec.get("when"), dict)
            for node in _nodes(spec["when"])
            if node.get("op") == "pattern"
        )
    )


def catalog_rules() -> list[Rule]:
    """Every catalog pattern with its template's own trend rule (the Indicators menu's "all patterns")."""
    entries = [e for e in load_catalog().entries if e.kind == "strategy" and e.file.startswith("patterns/")]
    return [Rule.of(load_template(entry.file)["when"]) for entry in entries]


def _utc(moment: datetime | pd.Timestamp) -> pd.Timestamp:
    stamp = pd.Timestamp(moment)
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def _stored_bars(
    session: Session, symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp, now: pd.Timestamp
) -> tuple[pd.DataFrame, Callable[[Any], pd.Timestamp]] | None:
    """Closed regular-session candles of `timeframe` up to `end`, from `start` less the lead-in, and a function
    giving the close time of the candle at an index point; None when nothing is stored."""
    if timeframe in ("1d", "1w"):
        daily = read_bars(
            session,
            symbol,
            "1d",
            (start - timedelta(days=_LEAD_IN_DAYS[timeframe])).date(),
            (end + timedelta(days=7 if timeframe == "1w" else 0)).date(),  # a week reaches past `end`
            "stock",
            as_of=now,
        )
        if daily.empty:
            return None
        if timeframe == "1d":
            return daily, lambda day: trading_session("stock", day).regular_close

        def week_close(monday: date) -> pd.Timestamp:
            last_day = daily.index[(daily.index >= monday) & (daily.index < monday + timedelta(days=7))][-1]
            return trading_session("stock", last_day).regular_close

        return _weekly_bars(daily, "stock"), week_close
    width = _BAR_MINUTES[timeframe]
    # Read one candle past `end`: a candle that starts at `end` completes after it.
    first, last = start - timedelta(days=_INTRADAY_LEAD_IN_DAYS), end + timedelta(minutes=width)
    minutes = read_bars(session, symbol, "1m", first, last, "stock", as_of=now)
    if minutes.empty:
        return None
    annotated = annotate(minutes, "stock")
    frame = _resample(annotated[annotated["phase"] == "regular"], "stock", width, now)
    if frame.empty:
        return None

    def candle_close(point: pd.Timestamp) -> pd.Timestamp:
        # the last bin of the session is shorter than its width
        return min(point + timedelta(minutes=width), trading_session("stock", frame.loc[point, "day"]).regular_close)

    return frame, candle_close


def _pattern_markers(
    session: Session,
    symbol: str,
    timeframe: str,
    rules: list[Rule],
    start: pd.Timestamp,
    end: pd.Timestamp,
    now: pd.Timestamp,
) -> list[PatternMarkerOut]:
    stored = None if symbol.startswith("/") or not rules else _stored_bars(session, symbol, timeframe, start, end, now)
    if stored is None:
        return []
    frame, close_of = stored
    found: dict[tuple[str, Any], PatternMarkerOut] = {}
    for rule in rules:
        for occurrence in patterns.occurrences(frame, rule.pattern, trend=rule.trend, trend_bars=rule.trend_bars):
            at = occurrence.bar_time
            if not start <= _utc(at) <= end:
                continue
            candle = occurrence.evidence
            found.setdefault(
                (rule.pattern, at),
                PatternMarkerOut(
                    pattern=rule.pattern,
                    template=rule.pattern.replace("_", "-"),
                    bar_start=utc_datetime(at),
                    bar_close=utc_datetime(close_of(at)),
                    ohlc=[candle["open"], candle["high"], candle["low"], candle["close"]],
                ),
            )
    return sorted(found.values(), key=lambda marker: (marker.bar_start, marker.pattern))


def _fire_markers(
    session: Session, user_id: int, symbol: str, start: pd.Timestamp, end: pd.Timestamp
) -> list[FireMarkerOut]:
    rows = session.execute(
        select(Signal.id, Strategy.name, Signal.bar_time)
        .join(StrategyVersion, Signal.strategy_version_id == StrategyVersion.id)
        .join(Strategy, StrategyVersion.strategy_id == Strategy.id)
        .where(
            Strategy.owner_user_id == user_id,
            Signal.symbol == symbol,
            Signal.bar_time >= start.to_pydatetime(),
            Signal.bar_time <= end.to_pydatetime(),
        )
        .order_by(Signal.bar_time, Signal.id)
    ).all()
    return [FireMarkerOut(signal_id=row.id, strategy_name=row.name, bar_time=row.bar_time) for row in rows]


def markers_for(
    session: Session,
    user_id: int,
    symbol: str,
    timeframe: str,
    *,
    start: datetime | None,
    end: datetime | None,
    all_patterns: bool,
    now: datetime,
) -> MarkersOut:
    """Markers whose bar start (patterns) or bar time (fires) falls in `[start, end]`. `end` defaults to `now`
    and `start` to a default span for the timeframe; the span never exceeds what the bars route serves."""
    stop = _utc(end or now)
    begin = _utc(start) if start else stop - timedelta(days=_DEFAULT_DAYS[timeframe])
    begin = max(begin, stop - timedelta(days=_MAX_SOURCE_DAYS[timeframe]))
    rules = catalog_rules() if all_patterns else strategy_rules(session, user_id)
    return MarkersOut(
        patterns=_pattern_markers(session, symbol, timeframe, rules, begin, stop, _utc(now)),
        fires=_fire_markers(session, user_id, symbol, begin, stop),
    )


@router.get("/{symbol:path}/markers", response_model=MarkersOut)
def markers(
    symbol: str,
    timeframe: Interval = "15m",
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = None,
    all_patterns: bool = False,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> MarkersOut:
    """Pattern markers on closed bars (drawn below the bar) plus the fires of her strategies (a bell above),
    filtered to `from`..`to` on the bar start for patterns and the bar time for fires."""
    validate_symbol(symbol)
    if stub_enabled():
        return stub_market.markers(symbol, timeframe, all_patterns, from_, to)
    return markers_for(
        session,
        user.id,
        symbol,
        timeframe,
        start=from_,
        end=to,
        all_patterns=all_patterns,
        now=datetime.now(UTC),
    )
