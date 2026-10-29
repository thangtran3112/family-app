import os
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import alert_state
from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.fundamental import ImportStateOut, StatusAiDailyOut, StatusOptionsOut
from ai_trading.api.schemas.platform import StatusAlertsOut, StatusMarketOut, StatusScansOut
from ai_trading.api.stamp import feed_last_ok, make_stamp
from ai_trading.core.freshness import market_state
from ai_trading.covered_calls.service import CHAIN_HEALTH
from ai_trading.data.refresher import STRIP_FEED
from ai_trading.data.universe import MARKET_STRIP
from ai_trading.db.models import Alert, SymbolMetrics
from ai_trading.fundamental.sources import fundamental_sources
from ai_trading.fundamental_stub import platform as fundamental_platform
from ai_trading.fundamental_stub import stub_enabled as fundamental_stub_enabled
from ai_trading.holdings import service as holdings_service
from ai_trading.jobs.refresh_15m import next_due
from ai_trading.mvp_stub import platform as stub_platform
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk", tags=["status"], dependencies=[Depends(get_current_user)])

_DELAYED_INTERVAL = timedelta(minutes=15)
_LIVE_INTERVAL = timedelta(minutes=1)  # the pause limit for gateway ticks is its 120 s floor (core/freshness.py)


class StreamingSlotsOut(BaseModel):
    used: int
    max: int


class StatusOut(BaseModel):
    market: StatusMarketOut
    quotes: Stamp
    scans: StatusScansOut
    alerts: StatusAlertsOut
    gateway: Literal["not_configured", "connected", "reconnecting", "down"]
    data_sources: Literal["unknown", "alpaca", "ibkr", "mixed"]
    streaming_slots: StreamingSlotsOut
    backups: None
    reconciliation: None
    holdings: ImportStateOut
    options: StatusOptionsOut
    ai_daily: StatusAiDailyOut


def _delayed_feed_stamp(session: Session, feed: str, now: datetime) -> Stamp:
    """A 15-minute-delayed feed's stamp. A feed that never ran (no row, or no `last_ok_at`) has nothing
    behind it: quality unavailable, no source, no as-of time."""
    last_ok = feed_last_ok(session, feed)
    if last_ok is None:
        return make_stamp(
            quality="unavailable", source=None, as_of=None, interval=_DELAYED_INTERVAL, last_ok_at=None, now=now
        )
    return make_stamp(
        quality="delayed-15m", source="alpaca", as_of=last_ok, interval=_DELAYED_INTERVAL, last_ok_at=last_ok, now=now
    )


def _seeded_quotes_stamp(session: Session, now: datetime) -> Stamp | None:
    """Before the first 15-minute pass the Desk holds the market strip's daily bars and nothing newer (a deploy on a
    weekend has no pass until Monday): an end-of-day stamp from the seed's own feed, so the status line does not claim
    there is no quote source while the dashboard shows closing prices. None when nothing was seeded."""
    last_ok = feed_last_ok(session, STRIP_FEED)
    as_of = session.execute(
        select(func.max(SymbolMetrics.as_of)).where(SymbolMetrics.symbol.in_(MARKET_STRIP))
    ).scalar_one()
    if last_ok is None or as_of is None:
        return None
    return make_stamp(
        quality="eod", source="alpaca", as_of=as_of, interval=_DELAYED_INTERVAL, last_ok_at=last_ok, now=now
    )


def _fundamental_status(session: Session, user: AuthedUser) -> dict[str, Any]:
    """The three Fundamental fields (02n §c3 #18). `holdings` is the real import state; `options` is connected while
    an Alpaca key is set and the last chain read did not fail (a rejected key shows on the first read, and the
    covered-call routes say unavailable on their own); no Desk AI run exists before step 5."""
    if fundamental_stub_enabled():
        return fundamental_platform.status()
    chain = fundamental_sources(os.environ)["option_chain"]
    connected = chain.state == "delayed" and CHAIN_HEALTH["ok"] is not False
    return {
        "holdings": holdings_service.import_state(session, user.email, user.id, os.environ),
        "options": {
            "as_of": CHAIN_HEALTH["at"] if connected and CHAIN_HEALTH["ok"] else None,
            "source": chain.source if connected else None,
            "quality": chain.quality if connected else "unavailable",
            "freshness": "delayed" if connected else "unavailable",
            "state": "connected" if connected else "not_connected",
        },
        "ai_daily": {"state": "not_started", "last_run_at": None},
    }


@router.get("/status", response_model=StatusOut)
def status(
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> StatusOut | dict[str, Any]:
    if stub_enabled():
        return {**stub_platform.status(), **_fundamental_status(session, user)}
    now = datetime.now(UTC)
    market = market_state(now)
    gateway = data_sources.gateway_status()
    quotes = _delayed_feed_stamp(session, "bars_delayed", now)
    if quotes.as_of is None:
        quotes = _seeded_quotes_stamp(session, now) or quotes
    live = gateway.state == "connected" and gateway.quality is not None and gateway.as_of is not None
    if live:
        # The gateway's own tick: its quality and time, so the stamp never claims more than IBKR said (02m §b4).
        ticked_at = gateway.as_of.to_pydatetime()
        quotes = make_stamp(
            quality=gateway.quality,
            source="ibkr",
            as_of=ticked_at,
            interval=_LIVE_INTERVAL,
            last_ok_at=ticked_at,
            now=now,
        )
    scans = _delayed_feed_stamp(session, "scan", now)
    unread = session.execute(
        select(func.count(Alert.id)).where(Alert.user_id == user.id, Alert.read_at.is_(None))
    ).scalar_one()
    return StatusOut(
        market=StatusMarketOut(session=market.session, next_open=market.next_open, last_close=market.last_close),
        quotes=quotes,
        # A scheduler that never ran has no next scan to promise.
        scans=StatusScansOut(**scans.model_dump(), next_run_at=None if scans.as_of is None else next_due(now)),
        alerts=StatusAlertsOut(state=alert_state(session, user.id, now), unread=unread),
        gateway=gateway.state,
        # Scans and backfill stay on Alpaca, so live IBKR quotes make the Desk "mixed".
        data_sources="mixed" if live else "alpaca" if quotes.as_of is not None else "unknown",
        streaming_slots=StreamingSlotsOut(used=gateway.lines_used, max=70),
        backups=None,
        reconciliation=None,
        **_fundamental_status(session, user),
    )
