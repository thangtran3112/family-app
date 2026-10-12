"""Whether an alert currently falls inside a user's quiet hours (02a §5: "Quiet hours apply. Risk
and system alerts ignore them.").
"""

from datetime import datetime, time

from ai_trading.core.calendar import ET


def in_quiet_hours(now: datetime, *, start: time, end: time, severity: str) -> bool:
    """`start`/`end` are America/New_York wall-clock times from `users.settings["quiet_hours"]`
    (`{"start": "22:00", "end": "07:00"}`); handles a window that wraps midnight. Always False for
    severity in ("system", "risk") -- 02a §5: "Risk and system alerts ignore them." `now` is a
    UTC-aware datetime; converted to ET internally.
    """
    if severity in ("system", "risk"):
        return False
    local = now.astimezone(ET).time()
    if start <= end:
        return start <= local < end
    return local >= start or local < end
