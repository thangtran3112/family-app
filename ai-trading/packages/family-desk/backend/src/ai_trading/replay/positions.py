"""Position rules shared by every practice thread: the `Hold` value, its money, its split restatement, the cash rule and
the stop crossing. Pure: no database, no clock, no network.

These were `holds.py`'s (02p §b), salvaged ahead of the swing code (ADR-0025): the rules do not care whether a position
is a swing hold row or the average-cost position of a freestyle lane (`journal.assemble`, ADR-0016), so they live here
and `holds.py` keeps only what the swing hold lifecycle needs (exit, mark close, set stop, day attribution).

Money rules are the journal's (02o decision 6): P/L is `sign * (price - entry) * shares` rounded to the cent, `sign` +1
for a long and -1 for a short, with no fees. R is P/L per share over `|entry - stop at entry|`; a stop set later moves
the line, never the R. A `Hold` is frozen: "changing" one returns a new hold (`dataclasses.replace`), so a caller can
keep the old one for an undo.

A hold stores its prices on the share basis of the day it was last restated to (`restate` runs before a day opens, so
a split changes shares and prices together and leaves P/L unchanged). Stops never exit (02o §6): `first_stop_crossing`
only finds the minute at which play should pause.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from math import floor
from typing import Any, Literal

import pandas as pd

SPLIT_TOLERANCE = 0.001  # |k - 1| below this is "no split": dividends are not in the split-adjusted series
MINUTE = pd.Timedelta(minutes=1)

Side = Literal["long", "short"]


class HoldProblem(Exception):
    """A rejected request with a plain sentence. It carries the same fields as `session.ReplayProblem`, which the
    caller turns it into (this module cannot import `session`)."""

    def __init__(self, message: str, path: str = "kind", status: int = 422) -> None:
        super().__init__(message)
        self.message, self.path, self.status = message, path, status


@dataclass(frozen=True)
class Hold:
    id: int | None
    symbol: str
    side: Side
    shares: int
    entry_day: date
    entry_at: pd.Timestamp
    entry_price: float
    stop_at_entry: float | None  # the R basis, set at entry and never changed
    stop_price: float | None  # the stop in force
    stop_hit_at: pd.Timestamp | None  # when play last paused on it; a new stop note clears it
    status: Literal["open", "closed"] = "open"
    exit_day: date | None = None
    exit_at: pd.Timestamp | None = None
    exit_price: float | None = None
    exit_source: Literal["her", "auto"] | None = None
    last_close: float | None = None  # the hold's value overnight: the last official close it was marked at
    last_close_day: date | None = None
    splits: tuple[dict[str, Any], ...] = ()

    @property
    def sign(self) -> int:
        return 1 if self.side == "long" else -1

    @property
    def notional(self) -> float:
        return self.shares * self.entry_price

    @property
    def is_open(self) -> bool:
        return self.status == "open"


# -- money -----------------------------------------------------------------------------------------------------------


def pnl(hold: Hold, price: float) -> float:
    return round(hold.sign * (price - hold.entry_price) * hold.shares, 2)


def r_multiple(hold: Hold, price: float) -> float | None:
    """None without a stop at entry, or when that stop equals the entry (no distance to measure)."""
    if hold.stop_at_entry is None or hold.stop_at_entry == hold.entry_price:
        return None
    return round(hold.sign * (price - hold.entry_price) / abs(hold.entry_price - hold.stop_at_entry), 2)


# -- splits ---------------------------------------------------------------------------------------------------------


def split_factor(raw_prev_close: float, adj_prev_close: float, raw_close: float, adj_close: float) -> float:
    """`k = r(D-1) / r(D)` with r(d) = raw close / split-adjusted close (02p b4): 10.0 for a 10-for-1 split, 0.1 for a
    1-for-10 reverse split. Rounded to six decimals, and exactly 1.0 for float noise or a dividend-sized wobble."""
    if min(raw_prev_close, adj_prev_close, raw_close, adj_close) <= 0:
        raise ValueError("split_factor needs positive closes")
    k = round((raw_prev_close / adj_prev_close) / (raw_close / adj_close), 6)
    return 1.0 if abs(k - 1) <= SPLIT_TOLERANCE else k


def restate(hold: Hold, k: float, day: date) -> Hold:
    """The hold on the share basis of `day`, which a split with ratio `k` took effect on (before the open). Shares
    round down ("cash in lieu not modeled"); prices divide by `k`. Only an open hold is restated."""
    if k == 1.0 or not hold.is_open:
        return hold
    # k carries six decimals (an error of up to 5e-7 per share), so a 1-for-3 reverse split of 30 shares reads 9.99999
    shares = floor(hold.shares * k + 1e-9 + hold.shares * 5e-7)

    def scaled(price: float | None) -> float | None:
        return None if price is None else round(price / k, 6)

    return replace(
        hold,
        shares=shares,
        entry_price=round(hold.entry_price / k, 6),
        stop_at_entry=scaled(hold.stop_at_entry),
        stop_price=scaled(hold.stop_price),
        last_close=scaled(hold.last_close),
        splits=(
            *hold.splits,
            {"day": day.isoformat(), "ratio": k, "shares_before": hold.shares, "shares_after": shares},
        ),
    )


# -- the cash rule ----------------------------------------------------------------------------------------------------


def check_buying_power(*, shares: int, price: float, free_cash_usd: float) -> None:
    """The one size rule of a practice entry, like a broker's margin check: at least one share, and the notional fits
    the free cash. Long and short count the same (cash-secured, no margin). Nothing else limits how many names, lots or
    shares she may hold: a name takes any number of fills, each of which is checked here for the shares that OPEN or add
    to the position (the shares that close it need no cash)."""
    if shares < 1:
        raise HoldProblem("Shares must be at least 1", path="shares")
    if shares * price > free_cash_usd:
        # Whole dollars, rounded DOWN: $450.60 free reads "$450", never "$451" (an amount she could not spend).
        raise HoldProblem(f"Not enough practice cash · ${max(0, floor(free_cash_usd)):,} free", path="shares")


# -- the stop pause ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Crossing:
    """The first minute at which an open hold's stop was crossed. `at` is that bar's close (where play pauses);
    `price` is the bar's open for a gap (it opened already beyond the stop) and its close otherwise; `also` lists the
    other symbols whose stops were crossed in the same minute."""

    symbol: str
    stop_price: float
    at: pd.Timestamp
    price: float
    kind: Literal["cross", "gap"]
    also: tuple[str, ...]


def first_stop_crossing(
    holds: Sequence[Hold], minutes: Mapping[str, pd.DataFrame], previous: pd.Timestamp, target: pd.Timestamp
) -> Crossing | None:
    """The earliest stop crossing among the open holds with a live stop, in one-minute bars that CLOSE in
    `(previous, target]` (`minutes`: per symbol, UTC bar-start index, open/high/low/close). A long is crossed when
    `low <= stop`, a short when `high >= stop`. Ties go to the alphabetically first symbol. A bar closing after `target`
    is never read, so the playhead can be clamped to the answer without revealing anything past it."""
    found: list[Crossing] = []
    for hold in holds:
        frame = minutes.get(hold.symbol)
        if not hold.is_open or hold.stop_price is None or hold.stop_hit_at is not None or frame is None:
            continue
        closes = frame.index + MINUTE
        window = frame[(closes > previous) & (closes <= target)].sort_index()
        long_ = hold.side == "long"
        hit = window[window["low"] <= hold.stop_price] if long_ else window[window["high"] >= hold.stop_price]
        if hit.empty:
            continue
        bar = hit.iloc[0]
        gap = bar["open"] <= hold.stop_price if long_ else bar["open"] >= hold.stop_price
        found.append(
            Crossing(
                hold.symbol,
                hold.stop_price,
                hit.index[0] + MINUTE,
                float(bar["open"] if gap else bar["close"]),
                "gap" if gap else "cross",
                (),
            )
        )
    if not found:
        return None
    first = min(found, key=lambda c: (c.at, c.symbol))
    return replace(first, also=tuple(sorted(c.symbol for c in found if c.at == first.at and c is not first)))
