from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.alerts.runtime import alert_state
from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.schemas.common import Stamp
from ai_trading.api.schemas.platform import StatusAlertsOut, StatusMarketOut, StatusScansOut
from ai_trading.api.stamp import feed_last_ok, make_stamp
from ai_trading.core.freshness import market_state
from ai_trading.db.models import Alert
from ai_trading.jobs.refresh_15m import next_due
from ai_trading.mvp_stub import platform as stub_platform
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk", tags=["status"], dependencies=[Depends(get_current_user)])

_DELAYED_INTERVAL = timedelta(minutes=15)


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


@router.get("/status", response_model=StatusOut)
def status(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> StatusOut | dict[str, Any]:
    if stub_enabled():
        return stub_platform.status()
    now = datetime.now(UTC)
    market = market_state(now)
    quotes = _delayed_feed_stamp(session, "bars_delayed", now)
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
        gateway="not_configured",
        data_sources="alpaca" if quotes.as_of is not None else "unknown",
        streaming_slots=StreamingSlotsOut(used=0, max=70),
        backups=None,
        reconciliation=None,
    )
