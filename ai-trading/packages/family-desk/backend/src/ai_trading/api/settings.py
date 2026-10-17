"""`GET/PUT /api/desk/settings` (PROTO-BRIEF.md §4 L4): the current user's own `users.settings`
jsonb -- channel preferences, quiet hours (`notify.quiet_hours`/`notify.dispatch` read this same
column). A PUT is a full replace, matching the column's own "one blob" shape; there is no partial-
patch endpoint."""

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import User

router = APIRouter(prefix="/api/desk/settings", tags=["settings"])

_CHANNELS = {"inbox", "telegram", "slack"}
_HHMM = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")


class SettingsBody(BaseModel):
    settings: dict[str, Any]


def _validate_owned_settings(settings: dict[str, Any]) -> None:
    if "quiet_hours" in settings:
        quiet_hours = settings["quiet_hours"]
        if not isinstance(quiet_hours, dict) or any(
            not isinstance(quiet_hours.get(key), str) or not _HHMM.fullmatch(quiet_hours[key])
            for key in ("start", "end")
        ):
            raise HTTPException(status_code=422, detail="quiet_hours start and end must use HH:MM")

    if "channels" in settings:
        channels = settings["channels"]
        if not isinstance(channels, list) or any(
            not isinstance(channel, str) or channel not in _CHANNELS for channel in channels
        ):
            raise HTTPException(status_code=422, detail="channels must contain only inbox, telegram, or slack")


@router.get("", response_model=SettingsBody)
def get_settings(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)) -> SettingsBody:
    row = session.get(User, user.id)
    assert row is not None  # get_current_user already created it this request
    return SettingsBody(settings=row.settings)


@router.put("", response_model=SettingsBody)
def put_settings(
    body: SettingsBody, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> SettingsBody:
    _validate_owned_settings(body.settings)
    row = session.get(User, user.id)
    assert row is not None
    row.settings = body.settings
    session.commit()
    return SettingsBody(settings=row.settings)
