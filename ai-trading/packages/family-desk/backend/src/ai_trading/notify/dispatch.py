"""Sends `deliveries` rows whose channel is wired (02a §5 "action pipeline": "The notifier sends
the alerts."). Only `inbox` is wired at startup in Phase 3 (D-a) -- a `telegram`/`slack` delivery
with no entry in `channels` is left exactly as it is ("pending"), never crashed on and never
dropped, until the owner sets its keys and `api/main.py` wires it in.
"""

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from datetime import time as _time

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import Channel, ChannelError
from ai_trading.notify.quiet_hours import in_quiet_hours
from ai_trading.notify.redact import redact

RETRY_DELAYS_SECONDS: tuple[float, ...] = (1.0, 5.0, 15.0)  # 02 §11: "retried three times"

_DEFAULT_QUIET_HOURS = {"start": "22:00", "end": "07:00"}
_CHANNELS = {"inbox", "telegram", "slack"}
_HHMM = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")


@dataclass(frozen=True)
class DeliveryOutcome:
    delivery_id: int
    status: str  # "sent" | "failed" | "skipped_quiet_hours" | "skipped_preferences"


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


def dispatch_pending(
    session: Session,
    *,
    channels: dict[str, Channel],  # keyed by deliveries.channel ("inbox" needs no Channel)
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
) -> list[DeliveryOutcome]:
    """Every `deliveries` row with status="pending". `inbox` rows -> "sent" immediately (the
    inbox IS the `alerts` table). A channel row is skipped (left "pending") when
    `in_quiet_hours` is True for its alert's severity. Otherwise calls `channels[row.channel]
    .send(...)`, retrying up to `len(RETRY_DELAYS_SECONDS)` times with `sleep` between attempts
    on `ChannelError`; final failure -> `status="failed"`, `error=redact.redact(str(exc))`,
    `attempted_at=now`; success -> `status="sent"`, `attempted_at=now`. One UPDATE per row;
    caller commits.
    """
    rows = session.execute(
        select(Delivery, Alert, User)
        .join(Alert, Delivery.alert_id == Alert.id)
        .join(User, Alert.user_id == User.id)
        .where(Delivery.status == "pending")
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
            continue  # not wired yet (D-a); row stays "pending" untouched

        if not _channel_preference_allows(user, delivery.channel):
            outcomes.append(DeliveryOutcome(delivery.id, "skipped_preferences"))
            continue

        if alert.severity not in {"risk", "system"}:
            quiet_window = _quiet_hours_window(user)
            if quiet_window is None:
                outcomes.append(DeliveryOutcome(delivery.id, "skipped_preferences"))
                continue
            start, end = quiet_window
            if in_quiet_hours(now, start=start, end=end, severity=alert.severity):
                outcomes.append(DeliveryOutcome(delivery.id, "skipped_quiet_hours"))
                continue

        last_error: ChannelError | None = None
        for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
            try:
                channel.send(title=alert.title, body=alert.body, severity=alert.severity)
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
