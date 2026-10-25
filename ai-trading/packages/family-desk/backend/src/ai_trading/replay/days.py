"""Notable days (02o decision 3): the top realized-volatility sessions of her watchlist symbols over the last
252 sessions, shown spoiler-free.

- **Score:** realized volatility of the regular session, `sqrt(sum r^2)` over 5-minute log returns built from
  1-minute raw SIP bars (the overnight gap is excluded: the first return runs from the session's first open).
  Ranked as a percentile within the symbol's last 252 sessions: `rv_pct_rank = 100 * (N - rank) / N`.
- **Tags:** `gap_up` / `gap_down` (|official open / prior close - 1| >= 2%, on the prior close's share basis after
  a split), `heavy_volume` (daily volume >= 2 x the previous 20 sessions' average, split-adjusted), `earnings`
  (the session that traded the report: the report date before the open, else the next session).
- **Spoiler-free:** only the gap (known at the open) and non-directional heat are stored or served. Never the
  day's change, range, close, or close location.
- **Self-healing:** `refresh` fills any of the last 252 sessions a symbol lacks, so the first run backfills a year
  (about 25 requests per symbol) and a daily run fetches one day. Run by the daily-close job and the prep CLI.

Deviation from the R0 script: `rvol` uses daily-bar volume for both the day and its baseline (R0 summed regular-
hours minute volume), so an incremental daily run needs no old minute bars; the two agree to a few percent.
"""

import logging
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from ai_trading_common.errors import NoData, ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ai_trading.core.calendar import previous_session, session
from ai_trading.db.models import ReplayNotableDay, ReplaySession, Watchlist, WatchlistItem
from ai_trading.replay import fixture

log = logging.getLogger(__name__)

LOOKBACK_SESSIONS = 252
HISTORY_SESSIONS = 21  # 20 for the volume average plus one for the first scored day's prior close
GAP_TAG_PCT = 2.0
HEAVY_VOLUME_X = 2.0
EMBARGO = timedelta(minutes=15)
_BAR_COLUMNS = ("open", "high", "low", "close", "volume")


def last_sessions(now: datetime, count: int) -> list[date]:
    """The last `count` finished sessions (regular close plus the SIP embargo has passed), oldest first."""
    cursor = pd.Timestamp(now).tz_convert("America/New_York").date()
    found = session("stock", cursor)
    if found is None or pd.Timestamp(now) < found.regular_close + EMBARGO:
        cursor = previous_session("stock", cursor)
    out = [cursor]
    while len(out) < count:
        out.append(previous_session("stock", out[-1]))
    return sorted(out)


def watchlist_symbols(db: Session, user_id: int | None = None) -> list[str]:
    """Stock symbols on the user's watchlists (every user's when `user_id` is None), sorted."""
    query = select(WatchlistItem.symbol).join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
    query = query.where(WatchlistItem.asset_type == "stock")
    if user_id is not None:
        query = query.where(Watchlist.user_id == user_id)
    return sorted(set(db.execute(query).scalars()))


def realized_vol(minutes: pd.DataFrame, open_ts: pd.Timestamp) -> float:
    """`sqrt(sum r^2)` over 5-minute log returns of one regular session's 1-minute bars."""
    bin_ = (minutes.index - open_ts) // pd.Timedelta(minutes=5)
    close5 = minutes["close"].groupby(bin_).last()
    path = np.log(np.concatenate([[minutes["open"].iloc[0]], close5.to_numpy()]))
    return float(np.sqrt((np.diff(path) ** 2).sum()))


def _next(day: date) -> date:
    cursor = day + timedelta(days=1)
    while session("stock", cursor) is None:
        cursor += timedelta(days=1)
    return cursor


def reaction_days(events: list[tuple[date, str]], gap: pd.Series) -> set[date]:
    """The session that traded each report: before the open, the report date; after the close, the next session;
    with no time of day, whichever of the two has the larger absolute opening gap."""
    out: set[date] = set()
    for report, timing in events:
        text = (timing or "").lower()
        first = report if session("stock", report) is not None else _next(report)
        later = _next(report)
        if text.startswith("pre"):
            out.add(first)
        elif text.startswith("post"):
            out.add(later)
        else:
            a = abs(gap.get(first, np.nan)) if first in gap.index else -1.0
            b = abs(gap.get(later, np.nan)) if later in gap.index else -1.0
            out.add(first if a > b else later)
    return out


def earnings_events(sources: DataSources, symbol: str, now: datetime) -> list[tuple[date, str]]:
    """Report dates from the first earnings provider that has them (the chain's first answer may carry none)."""
    for provider in getattr(sources.earnings, "providers", ()):
        try:
            results = provider.earnings_results(symbol, now=pd.Timestamp(now))
        except (NoData, ProviderError):
            continue
        events = [(r.report_date, r.report_time or "") for r in results if r.report_date]
        if events:
            return events
    return []


def _scores(minutes: pd.DataFrame, raw: pd.DataFrame, adjusted: pd.DataFrame, days: list[date]) -> pd.DataFrame:
    """Per-day rv, gap and rvol for `days`. `raw` and `adjusted` are daily frames (date index) with enough
    history before the first day for its prior close and the 20-session volume baseline."""
    rows: dict[date, dict[str, float]] = {}
    for day in days:
        found = session("stock", day)
        if found is None:
            continue
        regular = minutes[(minutes.index >= found.regular_open) & (minutes.index < found.regular_close)]
        if regular.empty:
            continue
        rows[day] = {"rv": realized_vol(regular, found.regular_open)}
    frame = pd.DataFrame.from_dict(rows, orient="index", columns=["rv"])
    if frame.empty:
        return frame.assign(gap_pct=np.nan, rvol=np.nan)
    a = (adjusted["close"] / raw["close"]).reindex(raw.index)
    ordered = list(raw.index)
    gap: dict[date, float] = {}
    factor = pd.Series(1.0, index=raw.index)
    for i in range(1, len(ordered)):
        d, p = ordered[i], ordered[i - 1]
        basis = 1.0
        if not (np.isnan(a.get(d, np.nan)) or np.isnan(a.get(p, np.nan))):
            ratio = a[p] / a[d]
            if abs(ratio - 1) > 0.10:  # a split or reverse split between p and d (dividends are well under 10%)
                basis = ratio
                factor[factor.index < d] *= ratio
        gap[d] = (raw.loc[d, "open"] / (raw.loc[p, "close"] * basis) - 1) * 100
    volume = raw["volume"] / factor
    average = volume.rolling(20).mean().shift(1)
    frame["gap_pct"] = pd.Series(gap).reindex(frame.index)
    frame["rvol"] = (volume / average).reindex(frame.index)
    return frame


def _store(db: Session, symbol: str, scored: pd.DataFrame, react: set[date], now: datetime) -> None:
    for day, row in scored.iterrows():
        tags = []
        if not np.isnan(row["gap_pct"]):
            if row["gap_pct"] >= GAP_TAG_PCT:
                tags.append("gap_up")
            elif row["gap_pct"] <= -GAP_TAG_PCT:
                tags.append("gap_down")
        if not np.isnan(row["rvol"]) and row["rvol"] >= HEAVY_VOLUME_X:
            tags.append("heavy_volume")
        if day in react:
            tags.append("earnings")
        values = {
            "symbol": symbol,
            "day": day,
            "rv": float(row["rv"]),
            "rv_pct_rank": 0.0,
            "gap_pct": None if np.isnan(row["gap_pct"]) else round(float(row["gap_pct"]), 2),
            "rvol": None if np.isnan(row["rvol"]) else round(float(row["rvol"]), 2),
            "tags": tags,
            "computed_at": now,
        }
        db.execute(
            insert(ReplayNotableDay)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["symbol", "day"], set_={k: v for k, v in values.items() if k not in ("symbol", "day")}
            )
        )


def rerank(db: Session, symbol: str, sessions: list[date]) -> None:
    """Recompute `rv_pct_rank` over the symbol's rows inside the lookback (the window slides every day)."""
    rows = list(
        db.execute(
            select(ReplayNotableDay).where(ReplayNotableDay.symbol == symbol, ReplayNotableDay.day.in_(sessions))
        ).scalars()
    )
    n = len(rows)
    for rank, row in enumerate(sorted(rows, key=lambda r: (-r.rv, r.day)), start=1):
        row.rv_pct_rank = round(100.0 * (n - rank) / n, 1)
    db.flush()


def refresh(db: Session, sources: DataSources, *, now: datetime, symbols: list[str] | None = None) -> dict[str, Any]:
    """Fill the missing sessions of the last 252 for each symbol. Returns `{symbol: sessions added}`; a symbol the
    provider cannot serve is logged and skipped, never fatal."""
    window = last_sessions(now, LOOKBACK_SESSIONS)
    added: dict[str, int] = {}
    for symbol in symbols if symbols is not None else watchlist_symbols(db):
        have = set(db.execute(select(ReplayNotableDay.day).where(ReplayNotableDay.symbol == symbol)).scalars())
        missing = [d for d in window if d not in have]
        if not missing:
            added[symbol] = 0
            continue
        try:
            first, last = session("stock", missing[0]), session("stock", missing[-1])
            assert first is not None and last is not None
            minutes = sources.bars.bars(
                symbol, "1m", first.regular_open, last.regular_close, now=now, adjustment="raw"
            ).frame
            history_start = first.regular_open - timedelta(days=HISTORY_SESSIONS * 2 + 10)
            raw = sources.bars.bars(symbol, "1d", history_start, last.extended_close, now=now, adjustment="raw").frame
            adjusted = sources.bars.bars(symbol, "1d", history_start, last.extended_close, now=now).frame
            scored = _scores(minutes, raw, adjusted, missing)
            react = reaction_days(earnings_events(sources, symbol, now), scored["gap_pct"])
            _store(db, symbol, scored, react, now)
            rerank(db, symbol, window)
            added[symbol] = len(scored)
        except (NoData, ProviderError) as exc:
            log.warning("notable days skipped for %s: %s", symbol, exc)
            added[symbol] = 0
    return added


# -- reading -------------------------------------------------------------------------------------------------


def _weekday(day: date) -> str:
    return day.strftime("%a")


def list_days(db: Session, user_id: int, *, symbol: str | None, limit: int, now: datetime) -> dict[str, Any]:
    """The hub's notable-days table: spoiler-free fields only, with how many attempts she has on each day."""
    if fixture.stub_enabled():
        data = fixture.notable_days()
        symbols = list(data["symbols"])
        wanted = [symbol] if symbol else symbols
        rows = [{**e, "rv_pct_rank": e["rv_pct_rank"]} for s in wanted for e in data["days"].get(s, [])]
        as_of = None
    else:
        symbols = watchlist_symbols(db, user_id)
        wanted = [symbol] if symbol else symbols
        window = last_sessions(now, LOOKBACK_SESSIONS)
        found = list(
            db.execute(
                select(ReplayNotableDay).where(ReplayNotableDay.symbol.in_(wanted), ReplayNotableDay.day.in_(window))
            ).scalars()
        )
        by_symbol: dict[str, list[ReplayNotableDay]] = {}
        for row in found:
            by_symbol.setdefault(row.symbol, []).append(row)
        rows = []
        for sym, entries in by_symbol.items():
            for rank, row in enumerate(sorted(entries, key=lambda r: (-r.rv, r.day)), start=1):
                rows.append(
                    {
                        "symbol": sym,
                        "day": row.day.isoformat(),
                        "rank": rank,
                        "rv_pct_rank": row.rv_pct_rank,
                        "gap_pct": row.gap_pct,
                        "tags": list(row.tags),
                    }
                )
        as_of = max((r.computed_at for r in found), default=None)
    attempts = _attempts(db, user_id)
    rows.sort(key=lambda r: (r["rank"], -r["rv_pct_rank"], r["symbol"]))
    days = [
        {
            "symbol": r["symbol"],
            "day": r["day"],
            "weekday": _weekday(date.fromisoformat(r["day"])),
            "rank": r["rank"],
            "rv_pct_rank": r["rv_pct_rank"],
            "gap_pct": r.get("gap_pct"),
            "tags": r["tags"],
            "attempts": attempts.get((r["symbol"], date.fromisoformat(r["day"])), 0),
        }
        for r in rows[:limit]
    ]
    return {
        "days": days,
        "symbols": symbols,
        "lookback_sessions": LOOKBACK_SESSIONS,
        "stamp": {
            "as_of": as_of or now,
            "source": "alpaca",
            "quality": "eod",
            "freshness": "replay",
        },
    }


def _attempts(db: Session, user_id: int) -> dict[tuple[str, date], int]:
    rows = db.execute(
        select(ReplaySession.symbol, ReplaySession.day, func.count())
        .where(ReplaySession.owner_user_id == user_id)
        .group_by(ReplaySession.symbol, ReplaySession.day)
    ).all()
    return {(symbol, day): int(n) for symbol, day, n in rows}


def clear(db: Session, symbol: str) -> None:
    """Drop a symbol's stored scores (the prep CLI's `--rebuild`)."""
    db.execute(delete(ReplayNotableDay).where(ReplayNotableDay.symbol == symbol))
