"""`GET/PUT /api/desk/settings` (PROTO-BRIEF.md §4 L4): the current user's own `users.settings`
jsonb -- channel preferences, quiet hours (`notify.quiet_hours`/`notify.dispatch` read this same
column). A PUT is a full replace, matching the column's own "one blob" shape; there is no partial-
patch endpoint."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import User

router = APIRouter(prefix="/api/desk/settings", tags=["settings"])


class SettingsBody(BaseModel):
    settings: dict[str, Any]


@router.get("", response_model=SettingsBody)
def get_settings(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)) -> SettingsBody:
    row = session.get(User, user.id)
    assert row is not None  # get_current_user already created it this request
    return SettingsBody(settings=row.settings)


@router.put("", response_model=SettingsBody)
def put_settings(
    body: SettingsBody, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> SettingsBody:
    row = session.get(User, user.id)
    assert row is not None
    row.settings = body.settings
    session.commit()
    return SettingsBody(settings=row.settings)
