"""`/api/desk/dashboard` (02m §a3.2): one aggregate read for the dashboard, composed from the stored results of the
scheduler's passes; it adds no storage.

- `market_strip`: SPY, QQQ and IWM from the stored metric rows; `/ES` and `/NQ` stay `unavailable` until the IBKR slot
  is live (no fabricated values).
- `signals`: the newest session's signals of her strategies, newest first, at most 20.
- `screener_matches`: one card per active filter from its last run (a filter that never ran reads `unavailable`).
- `watchlist`: the chosen list's rows (metrics plus the stored 15-minute bias label), in her order.
- `events`: earnings dates of the next two weeks for the symbols on her watchlists.

Every number comes from the same stored rows the watchlist table and the screener show, and every stamp from
`api/stamp.py`, so the UI never computes freshness. `DESK_MVP_STUB=1` answers from the snapshot instead.
"""

import logging
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.describe import signal_kind
from ai_trading.alerts.runtime import alert_state
from ai_trading.alerts.universe import watchlist_symbols
from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.platform import (
    DashboardEventOut,
    DashboardMarketOut,
    DashboardOut,
    DashboardScreenerMatchOut,
    DashboardSignalOut,
    DashboardWatchlistOut,
    DashboardWatchlistRowOut,
    MarketStripTileOut,
)
from ai_trading.api.stamp import SCAN_INTERVAL, feed_last_ok, make_stamp, no_run_stamp, run_stamp
from ai_trading.core.calendar import ET
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.freshness import market_state
from ai_trading.db.models import Signal, Strategy, StrategyVersion, SymbolMetrics, Watchlist, WatchlistItem
from ai_trading.mvp_stub import platform as stub_platform
from ai_trading.mvp_stub import stub_enabled
from ai_trading.screener import runner, service

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/desk/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_user)])

MARKET_STRIP = ("SPY", "QQQ", "IWM")
UNAVAILABLE_TILES = ("/ES", "/NQ")  # until the IBKR slot is live (02m §b4)
SIGNALS_MAX = 20
TOP_MATCHES = 3
EVENT_DAYS = 14
_EVENT_TTL = 3600.0  # seconds a symbol's calendar is kept; the provider is asked once per symbol, not per page load
_EVENT_FAILURE_TTL = 300.0
#: ponytail: a process-local cache; share it through the database if the API ever runs as several processes.
_EVENT_CACHE: dict[tuple[str, date], tuple[float, list[DashboardEventOut]]] = {}


def _metrics(session: Session, symbols: list[str]) -> dict[str, SymbolMetrics]:
    rows = session.execute(select(SymbolMetrics).where(SymbolMetrics.symbol.in_(symbols))).scalars()
    return {row.symbol: row for row in rows}


def _stamp(row: SymbolMetrics | None, last_ok_at: datetime | None, now: datetime) -> Stamp:
    """A metric row's stamp; a symbol with no stored row is `unavailable`."""
    if row is None:
        return no_run_stamp()
    return make_stamp(
        quality=row.quality, source=row.source, as_of=row.as_of, interval=SCAN_INTERVAL, last_ok_at=last_ok_at, now=now
    )


def _market_strip(
    stored: dict[str, SymbolMetrics], last_ok_at: datetime | None, now: datetime
) -> list[MarketStripTileOut]:
    tiles = []
    for symbol in MARKET_STRIP:
        row = stored.get(symbol)
        values = row.metrics if row is not None else {}
        tiles.append(
            MarketStripTileOut(
                symbol=symbol,
                last=values.get("last"),
                change_pct=values.get("change_pct"),
                stamp=_stamp(row, last_ok_at, now),
            )
        )
    for symbol in UNAVAILABLE_TILES:
        tiles.append(MarketStripTileOut(symbol=symbol, last=None, change_pct=None, stamp=no_run_stamp()))
    return tiles


def session_start(now: datetime) -> datetime:
    """When the newest session that has begun opened (04:00 ET): today's, or the last trading day's while no
    session has started yet today (overnight, weekends and holidays)."""
    stamp = pd.Timestamp(now)
    day = now.astimezone(ET).date()
    for _ in range(10):
        found = trading_session("stock", day)
        if found is not None and found.extended_open <= stamp:
            return found.extended_open.to_pydatetime()
        day -= timedelta(days=1)
    raise ValueError(f"no NYSE session within 10 days of {now.isoformat()}")


def _signals(session: Session, user_id: int, since: datetime) -> list[DashboardSignalOut]:
    rows = session.execute(
        select(Signal, Strategy.id, Strategy.name, StrategyVersion.spec)
        .join(StrategyVersion, Signal.strategy_version_id == StrategyVersion.id)
        .join(Strategy, StrategyVersion.strategy_id == Strategy.id)
        .where(Strategy.owner_user_id == user_id, Signal.bar_time >= since)
        .order_by(Signal.bar_time.desc(), Signal.id.desc())
        .limit(SIGNALS_MAX)
    ).all()
    return [
        DashboardSignalOut(
            id=row.id,
            symbol=row.symbol,
            strategy_id=strategy_id,
            strategy_name=name,
            # A version without an alert `when` (another lane's spec shape) is "other", not an error.
            kind=signal_kind(spec) if "when" in spec else "other",
            bar_time=row.bar_time,
            summary=f"{name} on {row.symbol}",
            evidence=row.evidence,
        )
        for row, strategy_id, name, spec in rows
    ]


def _screener_matches(session: Session, user_id: int, now: datetime) -> list[DashboardScreenerMatchOut]:
    cards = []
    for view in service.list_filters(session, user_id):
        run = service.last_run(session, view)
        top = [] if run is None else [match.symbol for match in runner.run_matches(session, run.id)[:TOP_MATCHES]]
        cards.append(
            DashboardScreenerMatchOut(
                filter_id=view.row.id,
                name=view.row.name,
                run_on=view.spec["watch"]["runOn"],
                scanned=0 if run is None else run.scanned,
                matches_total=0 if run is None else run.matches_total,
                top=top,
                stamp=run_stamp(session, run, now),
            )
        )
    return cards


def _chosen_watchlist(session: Session, user: AuthedUser, watchlist_id: int | None) -> Watchlist | None:
    """The requested list (404 unless hers), else her first `intraday` list, else her first list, else None."""
    if watchlist_id is not None:
        found = session.get(Watchlist, watchlist_id)
        if found is None or found.user_id != user.id:
            raise HTTPException(status_code=404, detail="watchlist not found")
        return found
    owned = select(Watchlist).where(Watchlist.user_id == user.id).order_by(Watchlist.id)
    intraday = session.execute(owned.where(Watchlist.horizon == "intraday").limit(1)).scalar_one_or_none()
    return intraday or session.execute(owned.limit(1)).scalar_one_or_none()


def _watchlist_rows(symbols: list[str], stored: dict[str, SymbolMetrics]) -> list[DashboardWatchlistRowOut]:
    rows = []
    for symbol in symbols:
        values = stored[symbol].metrics if symbol in stored else {}
        rows.append(
            DashboardWatchlistRowOut(
                symbol=symbol,
                last=values.get("last"),
                change_pct=values.get("change_pct"),
                rvol_10d=values.get("rvol_10d"),
                vs_vwap_pct=values.get("vs_vwap_pct"),
                # The refresher writes the 15-minute summary label beside the metrics; none yet reads "warming up".
                bias_label=values.get("bias_15m") or "warming up",
            )
        )
    return rows


def _watchlist_symbols(session: Session, user_id: int) -> list[str]:
    """Every stock symbol on any of her watchlists, once."""
    return sorted(
        session.execute(
            select(WatchlistItem.symbol)
            .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
            .where(Watchlist.user_id == user_id, WatchlistItem.asset_type == "stock")
            .distinct()
        ).scalars()
    )


def _events(data_sources: DataSources, symbols: list[str], today: date) -> list[DashboardEventOut]:
    """Earnings dates in the next `EVENT_DAYS` days for `symbols`, soonest first. A provider that fails leaves
    its symbol out for a few minutes instead of failing the page."""
    found: list[DashboardEventOut] = []
    for symbol in symbols:
        key = (symbol, today)
        cached = _EVENT_CACHE.get(key)
        if cached is None or cached[0] < time.monotonic():
            try:
                calendar = data_sources.earnings_calendar.earnings_calendar(
                    symbol, today, today + timedelta(days=EVENT_DAYS)
                )
                events = [
                    DashboardEventOut(symbol=symbol, kind="earnings", date=entry.report_date, timing=entry.timing)
                    for entry in calendar
                    if today <= entry.report_date <= today + timedelta(days=EVENT_DAYS)
                ]
                ttl = _EVENT_TTL
            except ProviderError as exc:
                log.debug("dashboard events: %s (%s)", symbol, type(exc).__name__)
                events, ttl = [], _EVENT_FAILURE_TTL
            cached = _EVENT_CACHE[key] = (time.monotonic() + ttl, events)
        found.extend(cached[1])
    return sorted(found, key=lambda event: (event.date, event.symbol))


@router.get("", response_model=DashboardOut)
def dashboard(
    request: Request,
    watchlist_id: int = Query(default=1),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> DashboardOut | dict[str, Any]:
    if stub_enabled():
        return stub_platform.dashboard(watchlist_id)
    # The frozen contract declares `default=1` (the stub's list); the real default is her first intraday list, so
    # only a `watchlist_id` the caller actually sent selects one.
    requested = watchlist_id if "watchlist_id" in request.query_params else None
    now = datetime.now(UTC)
    chosen = _chosen_watchlist(session, user, requested)
    listed = [symbol for symbol, _ in (watchlist_symbols(session, user.id, chosen.name) if chosen else None) or []]
    stored = _metrics(session, [*MARKET_STRIP, *listed])
    last_ok_at = feed_last_ok(session, "scan")
    market = market_state(now)
    return DashboardOut(
        stamp=_stamp(max(stored.values(), key=lambda row: row.as_of, default=None), last_ok_at, now),
        market=DashboardMarketOut(session=market.session, next_open=market.next_open),
        market_strip=_market_strip(stored, last_ok_at, now),
        signals=_signals(session, user.id, session_start(now)),
        screener_matches=_screener_matches(session, user.id, now),
        watchlist=DashboardWatchlistOut(
            id=0 if chosen is None else chosen.id,
            name="" if chosen is None else chosen.name,
            rows=_watchlist_rows(listed, stored),
        ),
        events=_events(data_sources, _watchlist_symbols(session, user.id), now.astimezone(ET).date()),
        alerts_state=alert_state(session, user.id, now),
    )
