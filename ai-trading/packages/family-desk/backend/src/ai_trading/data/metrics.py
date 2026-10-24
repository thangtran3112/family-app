"""The shared per-symbol metric row (02m §a1) from stored bars, and the `symbol_metrics` store.

The definitions are the Run 0 snapshot's (`temp/desk-desktop-mvp/snapshot.py`, `symbol_metrics`), so the
screener's recorded matches stay the oracle. Two stored inputs, both closed bars only:

- regular-session daily bars: `last`, `prev_close`, `change_pct`, `volume`, `avg_volume_20d`, `rvol_10d`,
  `atr_pct_14`, `rsi_14`, `gap_pct_open`, `high_252d`, `dist_to_252d_high_pct`;
- 1-minute bars (watchlist symbols only): `vwap_close`, `vs_vwap_pct`, `rvol_intraday_10d_at_close`.

While a session is in progress its daily bar is not stored yet, so a symbol with 1-minute bars of a day newer
than its last daily bar gets that day as a partial bar: `last`, `change_pct`, `volume`, `gap_pct_open`,
`high_252d` and `rvol_10d` follow it (`rvol_10d` becomes the same-clock-time intraday ratio, null without
ten prior days of 1-minute bars), while `avg_volume_20d`, `atr_pct_14` and `rsi_14` stay on closed daily
bars so they do not repaint all day. A symbol with no 1-minute bars has null VWAP fields, never a guess.
"""

import math
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core import indicators
from ai_trading.core.calendar import annotate
from ai_trading.data.bars import bar_close, read_bars
from ai_trading.db.models import SymbolMetrics

METRIC_KEYS = (
    "last",
    "prev_close",
    "change_pct",
    "volume",
    "avg_volume_20d",
    "rvol_10d",
    "atr_pct_14",
    "rsi_14",
    "gap_pct_open",
    "high_252d",
    "dist_to_252d_high_pct",
    "vwap_close",
    "vs_vwap_pct",
    "rvol_intraday_10d_at_close",
)
AVG_VOLUME_DAYS = 20
HIGH_DAYS = 252
RVOL_DAYS = 10
DAILY_LOOKBACK_DAYS = 420  # calendar days: 252 sessions plus the ATR and RSI warm-up
INTRADAY_LOOKBACK_DAYS = 18  # calendar days: ten prior sessions for the intraday RVOL baseline


def _num(value: object, digits: int = 4) -> float | None:
    """A finite float rounded the way the snapshot rounds, else None (JSON has no NaN)."""
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(number) or math.isinf(number)) else round(number, digits)


def _last(series: pd.Series) -> float | None:
    return _num(series.iloc[-1]) if len(series) else None


def _empty_row() -> dict[str, float | None]:
    return dict.fromkeys(METRIC_KEYS)


def _live_day(ann: pd.DataFrame, last_daily: date) -> tuple[date, pd.DataFrame] | None:
    """The newest day after `last_daily` that has regular-session 1-minute bars, with those bars."""
    regular = ann[(ann["phase"] == "regular") & (ann["day"] > last_daily)]
    if regular.empty:
        return None
    day = regular["day"].max()
    return day, regular[regular["day"] == day]


def metric_row(daily: pd.DataFrame, bars_1m: pd.DataFrame | None = None) -> dict[str, float | None]:
    """The metric row for one symbol.

    `daily`: closed regular-session daily bars indexed by trading day, oldest first. `bars_1m`: closed
    1-minute bars (extended hours included) indexed by UTC bar start, or None. Fewer than two daily bars
    gives an all-null row.
    """
    daily = daily.sort_index()
    if len(daily) < 2:
        return _empty_row()
    ann = annotate(bars_1m, "stock") if bars_1m is not None and len(bars_1m) else None
    live = _live_day(ann, daily.index[-1]) if ann is not None else None

    closed = daily
    working = daily
    if live is not None:
        day, today = live
        partial = pd.DataFrame(
            {
                "open": [today["open"].iloc[0]],
                "high": [today["high"].max()],
                "low": [today["low"].min()],
                "close": [today["close"].iloc[-1]],
                "volume": [today["volume"].sum()],
            },
            index=[day],
        )
        working = pd.concat([daily, partial])
    target_day = working.index[-1]

    last_close = float(working["close"].iloc[-1])
    prev_close = float(working["close"].iloc[-2])
    high_252 = float(working["high"].iloc[-HIGH_DAYS:].max())
    row: dict[str, float | None] = {
        "last": _num(last_close),
        "prev_close": _num(prev_close),
        "change_pct": _num((last_close / prev_close - 1) * 100, 3),
        "volume": _num(working["volume"].iloc[-1], 0),
        "avg_volume_20d": _num(closed["volume"].iloc[-AVG_VOLUME_DAYS:].mean(), 0),
        "rvol_10d": _last(indicators.rvol_daily(working, RVOL_DAYS)) if live is None else None,
        "atr_pct_14": _last(indicators.atr_percent(closed, 14, 50).pct),
        "rsi_14": _last(indicators.rsi(closed["close"], 14)),
        "gap_pct_open": _num((float(working["open"].iloc[-1]) - prev_close) / prev_close * 100, 3),
        "high_252d": _num(high_252),
        "dist_to_252d_high_pct": _num((last_close / high_252 - 1) * 100, 2),
        "vwap_close": None,
        "vs_vwap_pct": None,
        "rvol_intraday_10d_at_close": None,
    }

    if ann is not None:
        target = ann[(ann["day"] == target_day) & (ann["phase"] == "regular")]
        if not target.empty:
            vwap = indicators.session_vwap(ann)
            value = float(vwap.loc[target.index[-1]])
            row["vwap_close"] = _num(value)
            row["vs_vwap_pct"] = _num((last_close / value - 1) * 100, 3) if value > 0 else None
            intraday = _num(indicators.rvol_intraday(ann, RVOL_DAYS).loc[target.index[-1]], 3)
            row["rvol_intraday_10d_at_close"] = intraday
            if live is not None:
                row["rvol_10d"] = intraday
    return row


def _frame_or_none(frame: pd.DataFrame) -> pd.DataFrame | None:
    return None if frame.empty else frame


def symbol_metric_row(session: Session, symbol: str, *, now: pd.Timestamp) -> tuple[dict[str, float | None], datetime]:
    """Read `symbol`'s stored bars closed by `now` and compute its row. Returns the row and the instant it
    is current to: the close of the last 1-minute bar it used, or of the last daily bar."""
    today = now.tz_convert("America/New_York").date()
    daily = read_bars(session, symbol, "1d", today - timedelta(days=DAILY_LOOKBACK_DAYS), today, "stock", as_of=now)
    since = now - pd.Timedelta(days=INTRADAY_LOOKBACK_DAYS)
    minutes = _frame_or_none(read_bars(session, symbol, "1m", since, now, "stock", as_of=now))
    row = metric_row(daily, minutes)
    if daily.empty:
        return row, now.to_pydatetime()
    as_of = bar_close("stock", "1d", daily.index[-1])
    if minutes is not None:
        as_of = max(as_of, bar_close("stock", "1m", minutes.index[-1]))
    return row, as_of.to_pydatetime()


def store_metrics(
    session: Session, symbol: str, row: dict[str, Any], *, as_of: datetime, source: str, quality: str
) -> None:
    """Upsert one symbol's row. Caller commits."""
    stmt = pg_insert(SymbolMetrics).values(symbol=symbol, as_of=as_of, source=source, quality=quality, metrics=row)
    stmt = stmt.on_conflict_do_update(
        index_elements=["symbol"],
        set_={
            "as_of": stmt.excluded.as_of,
            "source": stmt.excluded.source,
            "quality": stmt.excluded.quality,
            "metrics": stmt.excluded.metrics,
        },
    )
    session.execute(stmt)


def refresh_metrics(session: Session, symbols: Iterable[str], *, now: pd.Timestamp) -> list[str]:
    """Recompute and store the row of every symbol that has at least two daily bars. Returns the symbols
    stored. A symbol with too little history keeps whatever row it had (or none): it is `no_data`, not zero."""
    stored = []
    for symbol in sorted(set(symbols)):
        row, as_of = symbol_metric_row(session, symbol, now=now)
        if row["last"] is None:
            continue
        live = row["vwap_close"] is not None
        store_metrics(
            session,
            symbol,
            row,
            as_of=as_of,
            source="alpaca",
            quality="delayed-15m" if live else "eod",
        )
        stored.append(symbol)
    return stored
