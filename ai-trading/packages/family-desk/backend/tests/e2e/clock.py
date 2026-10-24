"""Fixed weekday fixture clock; imported only by tests/e2e, never production modules."""

import os
from datetime import UTC, date, datetime

# 20:00 ET on a Thursday: after the close, but still on the seeded NY trading date. UTC rolls
# into Friday, so production's date-bounded engine query includes all Thursday bars.
E2E_NOW = datetime.fromisoformat(os.environ.get("DESK_E2E_NOW", "2026-10-16T00:00:00+00:00"))
if E2E_NOW.tzinfo is None or E2E_NOW.utcoffset() is None:
    raise ValueError("DESK_E2E_NOW must include a timezone")
E2E_NOW = E2E_NOW.astimezone(UTC)
E2E_EMAIL = "desk-e2e-principal"

# The browser specs move the frozen clock for one scenario (an open session, a stale feed) through
# `set_now`; `reset_now` puts it back. `E2E_NOW` stays the seed-time anchor.
_current = E2E_NOW


def current_now() -> datetime:
    return _current


def set_now(value: datetime) -> None:
    global _current
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("the scenario clock needs a timezone")
    _current = value.astimezone(UTC)


def reset_now() -> None:
    set_now(E2E_NOW)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        now = current_now()
        return now.astimezone(tz) if tz else now.replace(tzinfo=None)


class FrozenDate(date):
    @classmethod
    def today(cls):
        return current_now().date()


class _PandasClock:
    """Expose pandas unchanged except `Timestamp.now`, which API routes use for their as-of."""

    def __getattr__(self, name):
        import pandas as pd

        if name == "Timestamp":

            class TimestampClock:
                @staticmethod
                def now(tz=None):
                    return pd.Timestamp(current_now()).tz_convert(tz or "UTC")

            return TimestampClock
        return getattr(pd, name)


# Every API module that reads the wall clock through `datetime.now(...)`. Each is patched in place, so a
# route answers as of the fixture clock; a new module that reads the clock must be listed here, and
# `freeze_api_clocks` fails loudly if a listed one stops importing `datetime`.
_DATETIME_MODULES = (
    "alert_strategies",
    "alerts",
    "bars",
    "charts",
    "dashboard",
    "library",
    "quotes",
    "screener",
    "stamp",
    "status",
    "strategies",
    "technicals",
    "watchlists",
)


def freeze_api_clocks():
    """Freeze the API's clocks and return the callback that restores them."""
    import importlib

    from ai_trading.api import futures, market_data

    saved: list[tuple[object, str, object]] = [(futures, "date", futures.date), (market_data, "pd", market_data.pd)]
    for name in _DATETIME_MODULES:
        module = importlib.import_module(f"ai_trading.api.{name}")
        if module.datetime not in (datetime, FrozenDateTime):
            raise RuntimeError(f"ai_trading.api.{name} no longer imports datetime; update tests/e2e/clock.py")
        saved.append((module, "datetime", module.datetime))
        module.datetime = FrozenDateTime
    futures.date = FrozenDate
    market_data.pd = _PandasClock()

    def restore() -> None:
        for module, attribute, original in saved:
            setattr(module, attribute, original)

    return restore
