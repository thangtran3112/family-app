"""`GET/PUT /api/desk/settings` (PROTO-BRIEF.md §4 L4): the current user's own `users.settings`
jsonb -- channel preferences, quiet hours (`notify.quiet_hours`/`notify.dispatch` read this same
column). A PUT is a full replace, matching the column's own "one blob" shape; there is no partial-
patch endpoint.

`/settings/channels*` (02m §a3.8): the channel states, the Telegram chat-id link, and a test send
through the same channel objects `notify.dispatch.dispatch_pending` uses (`app.state.channels`)."""

import re
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.api.schemas.settings import SettingsChannelStateOut, SettingsChannelTestOut, SettingsTelegramLinkBody
from ai_trading.db.models import User
from ai_trading.mvp_stub import settings as stub_settings
from ai_trading.mvp_stub import stub_enabled
from ai_trading.notify.channel import Channel, ChannelError, ChannelNotConnected
from ai_trading.notify.dispatch import RETRY_DELAYS_SECONDS

router = APIRouter(prefix="/api/desk/settings", tags=["settings"])

_CHANNELS = {"inbox", "telegram", "slack"}
_DEFAULT_VIEWS = ("technical", "fundamental")  # a tuple: `in` never hashes an unhashable JSON value
_HHMM = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
_TEST_TITLE = "Test from Family Desk"
_TEST_BODY = "This is a test message from Family Desk. No action needed."
_TEST_SEVERITY = "system"


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

    if "default_view" in settings and settings["default_view"] not in _DEFAULT_VIEWS:
        raise HTTPException(status_code=422, detail="default_view must be technical or fundamental")

    if "pause_all" in settings and not isinstance(settings["pause_all"], bool):
        raise HTTPException(status_code=422, detail="pause_all must be true or false")


def _current_row(session: Session, user: AuthedUser) -> User:
    row = session.get(User, user.id)
    assert row is not None  # get_current_user already created it this request
    return row


def _channel_map(request: Request) -> dict[str, Channel]:
    return getattr(request.app.state, "channels", {})


def _slack_listed(row: User) -> bool:
    channels = row.settings.get("channels")
    return isinstance(channels, list) and "slack" in channels


def _telegram_state(row: User, channels: dict[str, Channel]) -> SettingsChannelStateOut:
    return SettingsChannelStateOut(
        channel="telegram", connected=bool(row.telegram_chat_id), configured="telegram" in channels
    )


def _slack_state(row: User, channels: dict[str, Channel]) -> SettingsChannelStateOut:
    configured = "slack" in channels
    return SettingsChannelStateOut(channel="slack", connected=configured and _slack_listed(row), configured=configured)


def _send_test(channel: Channel, **target: str) -> Literal["sent", "failed", "not_connected"]:
    """One send, then a retry after each wait in `RETRY_DELAYS_SECONDS`, the same schedule
    `dispatch_pending` uses. The exception text is dropped, so no token or webhook URL is echoed.
    A channel that cannot send right now (alerts off) answers `not_connected` without a retry."""
    for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
        try:
            channel.send(title=_TEST_TITLE, body=_TEST_BODY, severity=_TEST_SEVERITY, **target)
        except ChannelNotConnected:
            return "not_connected"
        except ChannelError:
            if attempt < len(RETRY_DELAYS_SECONDS):
                time.sleep(RETRY_DELAYS_SECONDS[attempt])
            continue
        return "sent"
    return "failed"


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


@router.get("/channels", response_model=list[SettingsChannelStateOut], response_model_exclude_unset=True)
def list_channels(
    request: Request, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[SettingsChannelStateOut]:
    row = _current_row(session, user)
    channels = _channel_map(request)
    return [
        SettingsChannelStateOut(channel="inbox", connected=True, locked=True),
        _telegram_state(row, channels),
        _slack_state(row, channels),
    ]


@router.put("/channels/telegram", response_model=SettingsChannelStateOut, response_model_exclude_unset=True)
def link_telegram(
    body: SettingsTelegramLinkBody,
    request: Request,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SettingsChannelStateOut:
    row = _current_row(session, user)
    row.telegram_chat_id = body.chat_id
    session.commit()
    return _telegram_state(row, _channel_map(request))


@router.post("/channels/{channel}/test", response_model=SettingsChannelTestOut)
def test_channel(
    channel: Literal["inbox", "telegram", "slack"],
    request: Request,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> SettingsChannelTestOut | dict[str, str]:
    row = _current_row(session, user)
    if stub_enabled():
        return stub_settings.channel_test(channel, has_chat_id=bool(row.telegram_chat_id))
    if channel == "inbox":
        return SettingsChannelTestOut(status="sent")  # the inbox IS the alerts table: nothing to send
    ready = bool(row.telegram_chat_id) if channel == "telegram" else _slack_listed(row)
    wired = _channel_map(request).get(channel)
    if not ready or wired is None:
        return SettingsChannelTestOut(status="not_connected")
    target = {"chat_id": row.telegram_chat_id} if channel == "telegram" and row.telegram_chat_id else {}
    return SettingsChannelTestOut(status=_send_test(wired, **target))
