"""Stub builder for `POST /api/desk/settings/channels/{channel}/test` (02m §a3.8). The channel list,
the Telegram link, and the settings body are real in both modes, so this is the only stub answer in
the family.

Returns a plain dict; `api/settings.py` validates it against `SettingsChannelTestOut`.
"""


def channel_test(channel: str, *, has_chat_id: bool) -> dict[str, str]:
    """Nothing is sent. Inbox always answers sent, telegram answers sent once a chat id is linked, and
    slack is never connected in the stub."""
    sent = channel == "inbox" or (channel == "telegram" and has_chat_id)
    return {"status": "sent" if sent else "not_connected"}
