"""Fixed weekday fixture clock; imported only by tests/e2e, never production modules."""

import os
from datetime import UTC, datetime

# 20:00 ET on a Thursday: after the close, but still on the seeded NY trading date. UTC rolls
# into Friday, so production's date-bounded engine query includes all Thursday bars.
E2E_NOW = datetime.fromisoformat(os.environ.get("DESK_E2E_NOW", "2026-10-16T00:00:00+00:00"))
if E2E_NOW.tzinfo is None or E2E_NOW.utcoffset() is None:
    raise ValueError("DESK_E2E_NOW must include a timezone")
E2E_NOW = E2E_NOW.astimezone(UTC)
E2E_EMAIL = "e2e@example.test"


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return E2E_NOW.astimezone(tz) if tz else E2E_NOW.replace(tzinfo=None)


class _PandasClock:
    """Expose pandas unchanged except `Timestamp.now`, which API routes use for their as-of."""

    def __getattr__(self, name):
        import pandas as pd

        if name == "Timestamp":

            class TimestampClock:
                @staticmethod
                def now(tz=None):
                    return pd.Timestamp(E2E_NOW).tz_convert(tz or "UTC")

            return TimestampClock
        return getattr(pd, name)


def freeze_api_clocks() -> None:
    from ai_trading.api import market_data, quotes, strategies

    market_data.pd = _PandasClock()
    quotes.datetime = FrozenDateTime
    strategies.datetime = FrozenDateTime
