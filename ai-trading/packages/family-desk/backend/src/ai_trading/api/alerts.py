"""`/api/desk/alerts*` (PROTO-BRIEF.md §4 L4): the inbox IS the `alerts` table (`notify.dispatch`'s
own docstring) -- reading it is just a plain owner-scoped query, no separate "inbox" table."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import Alert

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


def _to_out(row: Alert) -> AlertOut:
    return AlertOut(
        id=row.id,
        kind=row.kind,
        severity=row.severity,
        title=row.title,
        body=row.body,
        payload=row.payload,
        created_at=row.created_at,
        read_at=row.read_at,
    )


@router.get("", response_model=list[AlertOut])
def list_alerts(
    unread: bool | None = None,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AlertOut]:
    query = select(Alert).where(Alert.user_id == user.id)
    if unread is True:
        query = query.where(Alert.read_at.is_(None))
    elif unread is False:
        query = query.where(Alert.read_at.is_not(None))
    rows = session.execute(query.order_by(Alert.created_at.desc())).scalars()
    return [_to_out(row) for row in rows]


@router.post("/{alert_id}/read", response_model=AlertOut)
def mark_read(
    alert_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> AlertOut:
    row = session.get(Alert, alert_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="alert not found")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    session.commit()
    return _to_out(row)
