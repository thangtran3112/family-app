"""`/api/desk/alerts*` (PROTO-BRIEF.md §4 L4): the inbox IS the `alerts` table (`notify.dispatch`'s
own docstring) -- reading it is just a plain owner-scoped query, no separate "inbox" table. The delivery log
reads `deliveries` joined to their alert and strategy. `DESK_MVP_STUB=1` serves the fixture world (02m §d2)."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import and_, case, select, update
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.schemas.alerts import AlertLogOut, AlertReadAllOut, LogStatus
from ai_trading.db.models import Alert, Delivery, Strategy
from ai_trading.mvp_stub import alerts as mvp_alerts
from ai_trading.mvp_stub import stub_enabled

router = APIRouter(prefix="/api/desk/alerts", tags=["alerts"])


class AlertOut(BaseModel):
    id: int
    kind: str
    severity: str
    title: str
    body: str
    payload: dict[str, Any]
    created_at: datetime
    read_at: datetime | None
    symbol: str | None
    strategy_id: int | None
    strategy_name: str | None


def _to_out(row: Alert, strategy_name: str | None) -> AlertOut:
    return AlertOut(
        id=row.id,
        kind=row.kind,
        severity=row.severity,
        title=row.title,
        body=row.body,
        payload=row.payload,
        created_at=row.created_at,
        read_at=row.read_at,
        symbol=row.symbol,
        strategy_id=row.strategy_id,
        strategy_name=strategy_name,
    )


def _strategy_name(session: Session, strategy_id: int | None) -> str | None:
    strategy = None if strategy_id is None else session.get(Strategy, strategy_id)
    return None if strategy is None else strategy.name


@router.get("", response_model=list[AlertOut])
def list_alerts(
    unread: bool | None = None,
    symbol: str | None = None,
    strategy_id: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AlertOut]:
    if stub_enabled():
        return [
            AlertOut(**row)
            for row in mvp_alerts.inbox(
                unread=unread, symbol=symbol, strategy_id=strategy_id, limit=limit, offset=offset
            )
        ]
    query = (
        select(Alert, Strategy.name)
        .outerjoin(Strategy, Alert.strategy_id == Strategy.id)
        .where(Alert.user_id == user.id)
    )
    if unread is True:
        query = query.where(Alert.read_at.is_(None))
    elif unread is False:
        query = query.where(Alert.read_at.is_not(None))
    if symbol is not None:
        query = query.where(Alert.symbol == symbol)
    if strategy_id is not None:
        query = query.where(Alert.strategy_id == strategy_id)
    rows = session.execute(query.order_by(Alert.created_at.desc(), Alert.id.desc()).limit(limit).offset(offset)).all()
    return [_to_out(alert, name) for alert, name in rows]


@router.post("/read-all", response_model=AlertReadAllOut)
def mark_all_read(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> AlertReadAllOut:
    if stub_enabled():
        return AlertReadAllOut(**mvp_alerts.mark_all_read())
    result = session.execute(
        update(Alert).where(Alert.user_id == user.id, Alert.read_at.is_(None)).values(read_at=datetime.now(UTC))
    )
    session.commit()
    return AlertReadAllOut(marked=result.rowcount)


@router.post("/{alert_id}/read", response_model=AlertOut)
def mark_read(
    alert_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> AlertOut:
    if stub_enabled():
        fixture = mvp_alerts.mark_read(alert_id)
        if fixture is not None:
            return AlertOut(**fixture)
    row = session.get(Alert, alert_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="alert not found")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    session.commit()
    return _to_out(row, _strategy_name(session, row.strategy_id))


def _log_detail(status: str, channel: str) -> str:
    if status == "delivered":
        return "Delivered"
    if status == "held_quiet_hours":
        return "Held until quiet hours end"
    if status == "no_channel":
        return f"No channel connected for {channel}"
    return "Couldn't deliver · will not retry"  # never Delivery.error: it can carry provider detail


@router.get("/log", response_model=list[AlertLogOut])
def delivery_log(
    request: Request,
    status: LogStatus | None = None,
    symbol: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AlertLogOut]:
    if stub_enabled():
        return [
            AlertLogOut(**row, detail=_log_detail(row["status"], row["channel"]))
            for row in mvp_alerts.log(status=status, symbol=symbol, limit=limit, offset=offset)
        ]
    # Deliveries.status -> the log's status. A `pending` row is "no_channel" only on a channel nothing is wired
    # for; a wired pending row is still on its way, so it is left out (NULL), as is any unknown status.
    wired = ["inbox", *getattr(request.app.state, "channels", {})]
    mapped = case(
        (Delivery.status == "sent", "delivered"),
        (Delivery.status == "skipped_quiet_hours", "held_quiet_hours"),
        (Delivery.status == "skipped_preferences", "no_channel"),
        (and_(Delivery.status == "pending", Delivery.channel.not_in(wired)), "no_channel"),
        (Delivery.status == "failed", "failed"),
    )
    query = (
        select(
            Delivery.id,
            Delivery.alert_id,
            Delivery.channel,
            mapped.label("status"),
            Alert.created_at,
            Alert.symbol,
            Alert.strategy_id,
            Strategy.name,
        )
        .join(Alert, Delivery.alert_id == Alert.id)
        .outerjoin(Strategy, Alert.strategy_id == Strategy.id)
        .where(Alert.user_id == user.id, mapped.is_not(None))
    )
    if status is not None:
        query = query.where(mapped == status)
    if symbol is not None:
        query = query.where(Alert.symbol == symbol)
    rows = session.execute(
        query.order_by(Alert.created_at.desc(), Delivery.id.desc()).limit(limit).offset(offset)
    ).all()
    return [
        AlertLogOut(
            delivery_id=row.id,
            alert_id=row.alert_id,
            created_at=row.created_at,
            symbol=row.symbol,
            strategy_id=row.strategy_id,
            strategy_name=row.name,
            channel=row.channel,
            status=row.status,
            detail=_log_detail(row.status, row.channel),
        )
        for row in rows
    ]
