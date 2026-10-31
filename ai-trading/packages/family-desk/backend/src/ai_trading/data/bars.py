"""The bar store (02b §5): closed-bar-only upserts, as-of reads, backfill planning, and the
1-minute retention prune. Frames are in `ai_trading.core.evaluate`'s shape: `bars_1d` indexed by
trading day (`datetime.date`), `bars_1h`/`bars_1m` indexed by UTC bar start, columns `open high low
close volume`.

Pattern (not copied): ai-hedge-fund `hedge_fund/data/cached.py`'s rule, "never cache a trading day
that has not closed" (02a §11) -- here, "never store a bar whose period has not closed".
"""

from collections.abc import Sequence
from datetime import date, timedelta

import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, Asset, session
from ai_trading.db.models import Bar1d, Bar1h, Bar1m

Timeframe = str  # "1d" | "1h" | "1m"

_MODEL = {"1d": Bar1d, "1h": Bar1h, "1m": Bar1m}
_COLUMNS = ("open", "high", "low", "close", "volume")
_RETENTION_1M = timedelta(days=90)
#: Rows per INSERT. A row binds 8 parameters and psycopg caps a statement at 65,535, so one statement tops out
#: near 8,191 rows; a first-time 16-day minute backfill is ~9k rows. 5,000 stays far under the cap.
_UPSERT_CHUNK = 5_000


def _bar_day(asset: Asset, start: pd.Timestamp) -> date:
    """The trading day `start` (a UTC bar start) falls on, mirroring `core.calendar.annotate`'s
    own shift: a future's "day" is its overnight session, which starts at 18:00 ET the evening
    before, so it is attributed to the next calendar day by shifting 6 hours before taking the
    ET date."""
    shift = timedelta(hours=6) if asset == "future" else timedelta(0)
    return (start.tz_convert(ET) + shift).date()


def bar_close(asset: Asset, timeframe: Timeframe, point: date | pd.Timestamp) -> pd.Timestamp:
    """The instant `point` (a `bars_1d` day, or a `bars_1h`/`bars_1m` bar start) closes.

    `1m`: one minute after the start. `1h`: one hour after the start, except a session's short
    last hour (a half day), which closes at that session's regular close instead -- only when the
    regular close falls strictly between the bar's start and its natural hour-later close; a
    post-market hourly bar (already past the regular close) is never pulled backward by this.
    `1d`: the trading day's own regular close (16:00 or 13:00 ET).
    """
    if timeframe == "1d":
        found = session(asset, point)
        if found is None:
            raise ValueError(f"{point} is not a trading day for {asset!r}")
        return found.regular_close
    if timeframe == "1m":
        return point + pd.Timedelta(minutes=1)
    if timeframe == "1h":
        natural_close = point + pd.Timedelta(hours=1)
        found = session(asset, _bar_day(asset, point))
        if found is not None and point < found.regular_close <= natural_close:
            return found.regular_close
        return natural_close
    raise ValueError(f"unknown timeframe {timeframe!r}")


def upsert_bars(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    frame: pd.DataFrame,
    source: str,
    asset: Asset,
    *,
    now: pd.Timestamp,
) -> None:
    """Idempotent upsert of `frame` into the `timeframe` bar table. Raises `ValueError` -- and
    writes nothing -- if any row has not closed by `now` (Review Focus 2: a forming bar can never
    be stored and repaint later)."""
    if frame.empty:
        return
    model = _MODEL[timeframe]
    time_column = "day" if timeframe == "1d" else "bar_start"

    for point in frame.index:
        close = bar_close(asset, timeframe, point)
        if now < close:
            raise ValueError(f"{symbol} {timeframe} bar at {point} has not closed by {now} (closes {close})")

    rows = [
        {"symbol": symbol, time_column: point, "source": source, **{c: float(row[c]) for c in _COLUMNS}}
        for point, row in frame.iterrows()
    ]
    for offset in range(0, len(rows), _UPSERT_CHUNK):
        stmt = pg_insert(model).values(rows[offset : offset + _UPSERT_CHUNK])
        update_columns = {c: stmt.excluded[c] for c in (*_COLUMNS, "source")}
        stmt = stmt.on_conflict_do_update(index_elements=["symbol", time_column], set_=update_columns)
        session_.execute(stmt)


def read_bars(
    session_: Session,
    symbol: str,
    timeframe: Timeframe,
    start: date | pd.Timestamp,
    end: date | pd.Timestamp,
    asset: Asset,
    *,
    as_of: pd.Timestamp,
) -> pd.DataFrame:
    """Bars for `symbol` in `[start, end]` (inclusive) that had closed by `as_of` -- recomputed
    from each row's own close time, not from when it was written, so a replay at an earlier
    `as_of` never sees a bar that had not yet closed at that point even though it is already
    stored (Review Focus 6: no look-ahead)."""
    model = _MODEL[timeframe]
    time_column = model.day if timeframe == "1d" else model.bar_start
    rows = session_.execute(
        select(model).where(model.symbol == symbol, time_column >= start, time_column <= end).order_by(time_column)
    ).scalars()

    index: list[date | pd.Timestamp] = []
    data: dict[str, list[float]] = {c: [] for c in _COLUMNS}
    for row in rows:
        point = row.day if timeframe == "1d" else pd.Timestamp(row.bar_start)
        if bar_close(asset, timeframe, point) > as_of:
            continue
        index.append(point)
        for c in _COLUMNS:
            data[c].append(getattr(row, c))
    return pd.DataFrame(data, index=pd.Index(index))


def _sessions_in_range(asset: Asset, start: date, end: date) -> list[date]:
    days = []
    cursor = start
    while cursor <= end:
        if session(asset, cursor) is not None:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def missing_sessions(
    session_: Session, symbol: str, timeframe: Timeframe, asset: Asset, start: date, end: date
) -> list[date]:
    """XNYS/CMES sessions in `[start, end]` with no stored bar for `symbol`. For an intraday
    timeframe a missing session is a whole day with *no* bars at all -- quiet minutes inside a
    session that has some bars are normal, not a gap."""
    model = _MODEL[timeframe]
    days = _sessions_in_range(asset, start, end)
    if timeframe == "1d":
        present = set(session_.execute(select(model.day).where(model.symbol == symbol, model.day.in_(days))).scalars())
        return [d for d in days if d not in present]

    missing = []
    for d in days:
        found = session(asset, d)
        count = session_.execute(
            select(model.bar_start)
            .where(
                model.symbol == symbol,
                model.bar_start >= found.extended_open,
                model.bar_start < found.extended_close,
            )
            .limit(1)
        ).first()
        if count is None:
            missing.append(d)
    return missing


def prune_1m(session_: Session, *, now: pd.Timestamp) -> int:
    """Deletes `bars_1m` rows older than the 90-day retention window (02b §5). Returns the row
    count deleted."""
    cutoff = now - _RETENTION_1M
    result = session_.execute(Bar1m.__table__.delete().where(Bar1m.bar_start < cutoff))
    return result.rowcount


__all__: Sequence[str] = (
    "bar_close",
    "upsert_bars",
    "read_bars",
    "missing_sessions",
    "prune_1m",
)
