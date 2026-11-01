"""Practice working orders: a limit, stop or stop-limit entry that waits on the tape. Pure: no database, no clock.

A market entry never waits: it fills at the last print (`session.place_mark`). The three types here fill only on a LATER
one-minute bar, so a fill is always something the tape proved after the order was placed, and the forward-only clock
decides what may be read: `first_fill` looks at bars that CLOSE in `(since, target]` and nothing else.

Fill rules (OHLC of one-minute bars; a buy is a Buy fill and a sell a Sell fill, whatever the name's position is when
the order fills: the session nets it against the position, `session._place`):

- limit: a buy fills at the first bar whose low reaches the limit, at the limit, or at the bar's open when it opened
  through it. A sell mirrors it with the high.
- stop: a buy stop fills at the first bar whose high reaches the trigger, at the trigger, or at the open when the bar
  gapped past it. A sell stop mirrors it with the low.
- stop-limit: the stop leg triggers as above. If the limit still accepts the trigger price (a buy limit at or above
  it), the order fills on that bar at the trigger price. Otherwise it becomes a plain limit that is read from the NEXT
  bar on, because one bar does not say whether the price came back before or after the trigger.

A fill is stamped at the close of its bar and priced in whole cents. There is no spread, slippage or fees. Bracket (a
stop and a target that cancel each other) is not simulated; the Desk offers no way to place one.
"""

import math
from dataclasses import dataclass
from typing import Any

import pandas as pd

from ai_trading.replay.journal import fill_price

MINUTE = pd.Timedelta(minutes=1)

WORKING_TYPES = ("limit", "stop", "stop_limit")


class OrderProblem(Exception):
    """A rejected order with a plain sentence; the caller turns it into a `ReplayProblem`."""

    def __init__(self, message: str, path: str = "kind") -> None:
        super().__init__(message)
        self.message, self.path = message, path


@dataclass(frozen=True)
class Fill:
    at: pd.Timestamp  # the close of the bar that proved it
    price: float  # whole cents


def _positive(value: Any, path: str, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not (math.isfinite(value) and value > 0):
        raise OrderProblem(f"{label} must be a number above 0", path=path)
    return float(value)


def check_new(*, side: str, type_: str, limit: Any, trigger: Any, last: float) -> tuple[float | None, float | None]:
    """The limit and the trigger an order of this type needs (and only those), checked against the last price.
    Returns `(limit, trigger)`; raises `OrderProblem`. A stop sits beyond the last price, in the direction a buy
    rises or a sell falls; a limit may be on either side (a limit through the market is marketable: the caller fills
    it at once at the last price)."""
    if type_ not in WORKING_TYPES:
        raise OrderProblem("Choose limit, stop or stop-limit", path="orderType")
    wants_limit, wants_trigger = type_ in ("limit", "stop_limit"), type_ in ("stop", "stop_limit")
    if (limit is not None) != wants_limit:
        raise OrderProblem(
            "Enter a limit price" if wants_limit else "This order type takes no limit price", path="limitPrice"
        )
    if (trigger is not None) != wants_trigger:
        raise OrderProblem(
            "Enter a stop price" if wants_trigger else "This order type takes no stop price", path="stopPrice"
        )
    limit = None if limit is None else _positive(limit, "limitPrice", "Limit price")
    trigger = None if trigger is None else _positive(trigger, "stopPrice", "Stop price")
    if trigger is not None:
        if side == "long" and trigger <= last:
            raise OrderProblem("A buy stop goes above the last price", path="stopPrice")
        if side == "short" and trigger >= last:
            raise OrderProblem("A sell stop goes below the last price", path="stopPrice")
    return limit, trigger


def marketable(side: str, type_: str, limit: float | None, last: float) -> bool:
    """A limit that already accepts the last price fills now, at the last price (never worse than its limit)."""
    if type_ != "limit" or limit is None:
        return False
    return limit >= last if side == "long" else limit <= last


def _first(bars: pd.DataFrame, hit: pd.Series) -> pd.Series | None:
    found = bars[hit]
    return None if found.empty else found.iloc[0]


def _limit_leg(side: str, limit: float, bars: pd.DataFrame) -> Fill | None:
    buy = side == "long"
    bar = _first(bars, bars["low"] <= limit if buy else bars["high"] >= limit)
    if bar is None:
        return None
    open_ = float(bar["open"])
    price = min(limit, open_) if buy else max(limit, open_)
    return Fill(bar.name + MINUTE, fill_price(price))


def first_fill(
    *,
    side: str,
    type_: str,
    limit: float | None,
    trigger: float | None,
    triggered_at: pd.Timestamp | None,
    bars_1m: pd.DataFrame,
    since: pd.Timestamp,
    target: pd.Timestamp,
) -> tuple[Fill | None, pd.Timestamp | None]:
    """`(the fill, the stop-limit trigger time)` over the bars that close in `(since, target]`. The second value is the
    time the stop leg triggered (kept once known, so a later call reads only the limit leg); None for the other types.
    `bars_1m` is indexed by bar open (UTC) with open/high/low/close; later bars are never read."""
    closes = bars_1m.index + MINUTE
    window = bars_1m[(closes > since) & (closes <= target)].sort_index()
    buy = side == "long"
    if window.empty:
        return None, triggered_at
    if type_ == "limit":
        assert limit is not None
        return _limit_leg(side, limit, window), None
    assert trigger is not None
    if type_ == "stop":
        bar = _first(window, window["high"] >= trigger if buy else window["low"] <= trigger)
        if bar is None:
            return None, None
        open_ = float(bar["open"])
        price = max(trigger, open_) if buy else min(trigger, open_)
        return Fill(bar.name + MINUTE, fill_price(price)), None
    assert limit is not None  # stop-limit
    if triggered_at is not None:  # the stop leg fired on an earlier call: only the limit leg is left
        return _limit_leg(side, limit, window[window.index + MINUTE > triggered_at]), triggered_at
    bar = _first(window, window["high"] >= trigger if buy else window["low"] <= trigger)
    if bar is None:
        return None, None
    open_ = float(bar["open"])
    at_trigger = max(trigger, open_) if buy else min(trigger, open_)
    fired = bar.name + MINUTE
    if (limit >= at_trigger) if buy else (limit <= at_trigger):  # the limit accepts the trigger price: filled there
        return Fill(fired, fill_price(at_trigger)), fired
    return _limit_leg(side, limit, window[window.index + MINUTE > fired]), fired
