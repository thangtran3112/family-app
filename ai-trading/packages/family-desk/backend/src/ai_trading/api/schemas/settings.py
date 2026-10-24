"""Models for `/api/desk/settings/channels*` (02m §a3.8). The settings body itself stays `SettingsBody`
in `api/settings.py`, which this family extends in place."""

from typing import Literal

from pydantic import BaseModel, Field


class SettingsChannelStateOut(BaseModel):
    """`locked` is true only for the inbox, and `configured` is false until the owner wires the
    channel's key. The inbox row is sent without `configured`, and telegram/slack without `locked`
    (the endpoint uses `response_model_exclude_unset`), which is the a3.8 example shape."""

    channel: Literal["inbox", "telegram", "slack"]
    connected: bool
    locked: bool = False
    configured: bool = True


class SettingsChannelTestOut(BaseModel):
    status: Literal["sent", "not_connected", "failed"]


class SettingsTelegramLinkBody(BaseModel):
    chat_id: str = Field(pattern=r"^-?[0-9]{1,20}$")
