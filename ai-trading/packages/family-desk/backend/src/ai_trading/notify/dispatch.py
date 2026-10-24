"""Sends `deliveries` rows (02a §5 "action pipeline": "The notifier sends the alerts."), and records why one
was not sent (02m §a3.7, §b5.5) so the delivery log can show it:

- `skipped_quiet_hours`: held for the user's quiet hours; sent on a later pass once they end.
- `skipped_preferences`: the user's channel list leaves this channel off; sent later if she turns it on.
- `no_channel`: nothing is wired for this channel (no key stored for it), so the alert only reached the
  inbox. This one is final: turning a channel on later does not send alerts from before it existed.

A held or skipped row is looked at again on every pass for a day; after that it stays as recorded.
"""

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import time as _time

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import Channel, ChannelError
from ai_trading.notify.quiet_hours import in_quiet_hours
from ai_trading.notify.redact import redact

RETRY_DELAYS_SECONDS: tuple[float, ...] = (1.0, 5.0, 15.0)  # 02 §11: "retried three times"

#: A row skipped for quiet hours or preferences is re-checked while its alert is younger than this.
_RECHECK_WINDOW = timedelta(hours=24)
_RECHECK_STATUSES = ("skipped_quiet_hours", "skipped_preferences")

_DEFAULT_QUIET_HOURS = {"start": "22:00", "end": "07:00"}
_CHANNELS = {"inbox", "telegram", "slack"}
_HHMM = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")


@dataclass(frozen=True)
class DeliveryOutcome:
    delivery_id: int
    status: str  # "sent" | "failed" | "skipped_quiet_hours" | "skipped_preferences" | "no_channel"


def _channel_preference_allows(user: User, channel: str) -> bool:
    settings = user.settings
    if not isinstance(settings, dict):
        return False
    if "channels" not in settings:
        return True  # Legacy users retain the previous allow-all behavior.

    preferences = settings["channels"]
    return (
        isinstance(preferences, list)
        and all(isinstance(value, str) and value in _CHANNELS for value in preferences)
        and channel in preferences
    )


def _quiet_hours_window(user: User) -> tuple[_time, _time] | None:
    settings = user.settings
    if not isinstance(settings, dict):
        return None
    quiet = settings.get("quiet_hours")
    if quiet is None or quiet == {}:
        quiet = _DEFAULT_QUIET_HOURS
    if not isinstance(quiet, dict):
        return None

    start = quiet.get("start", _DEFAULT_QUIET_HOURS["start"])
    end = quiet.get("end", _DEFAULT_QUIET_HOURS["end"])
    if not isinstance(start, str) or not _HHMM.fullmatch(start) or not isinstance(end, str) or not _HHMM.fullmatch(end):
        return None
    return _time.fromisoformat(start), _time.fromisoformat(end)


def _target(channel: Channel, user: User) -> dict[str, str]:
    """Her own Telegram chat when she linked one (`PUT /settings/channels/telegram`); otherwise the channel's
    configured chat, as before. Other channels have no per-user target."""
    if channel.name == "telegram" and user.telegram_chat_id:
        return {"chat_id": user.telegram_chat_id}
    return {}


def dispatch_pending(
    session: Session,
    *,
    channels: dict[str, Channel],  # keyed by deliveries.channel ("inbox" needs no Channel)
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
) -> list[DeliveryOutcome]:
    """Every `deliveries` row with status="pending", plus rows held or skipped within the last day. `inbox`
    rows -> "sent" immediately (the inbox IS the `alerts` table). A channel nothing is wired for -> "no_channel".
    A channel the user's list leaves off -> "skipped_preferences"; one inside her quiet hours for a
    non-urgent alert -> "skipped_quiet_hours" (both are tried again on the next pass). Otherwise calls
    `channels[row.channel].send(...)`, retrying up to `len(RETRY_DELAYS_SECONDS)` times with `sleep` between
    attempts on `ChannelError`; final failure -> `status="failed"`, `error=redact.redact(str(exc))`,
    `attempted_at=now`; success -> `status="sent"`, `attempted_at=now`. One UPDATE per row; caller commits.
    """
    rows = session.execute(
        select(Delivery, Alert, User)
        .join(Alert, Delivery.alert_id == Alert.id)
        .join(User, Alert.user_id == User.id)
        .where(
            (Delivery.status == "pending")
            | (Delivery.status.in_(_RECHECK_STATUSES) & (Alert.created_at >= now - _RECHECK_WINDOW))
        )
        .order_by(Delivery.id)
    ).all()

    outcomes: list[DeliveryOutcome] = []
    for delivery, alert, user in rows:
        if delivery.channel == "inbox":
            delivery.status = "sent"
            delivery.attempted_at = now
            outcomes.append(DeliveryOutcome(delivery.id, "sent"))
            continue

        channel = channels.get(delivery.channel)
        if channel is None:
            delivery.status = "no_channel"
            delivery.attempted_at = now
            outcomes.append(DeliveryOutcome(delivery.id, "no_channel"))
            continue

        if not _channel_preference_allows(user, delivery.channel):
            delivery.status = "skipped_preferences"
            outcomes.append(DeliveryOutcome(delivery.id, "skipped_preferences"))
            continue

        if alert.severity not in {"risk", "system"}:
            quiet_window = _quiet_hours_window(user)
            if quiet_window is None:
                delivery.status = "skipped_preferences"
                outcomes.append(DeliveryOutcome(delivery.id, "skipped_preferences"))
                continue
            start, end = quiet_window
            if in_quiet_hours(now, start=start, end=end, severity=alert.severity):
                delivery.status = "skipped_quiet_hours"
                outcomes.append(DeliveryOutcome(delivery.id, "skipped_quiet_hours"))
                continue

        last_error: ChannelError | None = None
        for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
            try:
                channel.send(title=alert.title, body=alert.body, severity=alert.severity, **_target(channel, user))
            except ChannelError as exc:
                last_error = exc
                if attempt < len(RETRY_DELAYS_SECONDS):
                    sleep(RETRY_DELAYS_SECONDS[attempt])
                continue
            delivery.status = "sent"
            delivery.attempted_at = now
            outcomes.append(DeliveryOutcome(delivery.id, "sent"))
            break
        else:
            delivery.status = "failed"
            delivery.attempted_at = now
            delivery.error = redact(str(last_error))
            outcomes.append(DeliveryOutcome(delivery.id, "failed"))

    return outcomes
