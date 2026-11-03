"""Practice holds (02p §b): the lifecycle of a trade that stays open overnight. Pure: no database, no clock, no network.

A name has one open hold at a time and it is the name's average-cost position (ADR-0016): its `entry_price` is the
average cost of every fill that built it, and `shares` what is left of them. Adding shares re-averages the cost
(`journal.average_cost`); selling part closes a slice of it at that cost and leaves the cost alone.

The `Hold` value and the rules every position shares (money, split restatement, the cash rule, the stop crossing) live
in `positions.py` (ADR-0025). What is left here is what only the swing hold lifecycle needs: exiting and marking a
hold, the stop note, the swing day's free cash and its equity attribution. A `Hold` is frozen: "changing" one returns a
new hold (`dataclasses.replace`), so a caller can keep the old one for an undo.
"""

from collections.abc import Sequence
from dataclasses import replace
from datetime import date
from math import floor
from typing import Literal

import pandas as pd

from ai_trading.replay.positions import Hold, HoldProblem, Side, pnl


def _require_open(hold: Hold, message: str) -> None:
    if not hold.is_open:
        raise HoldProblem(message)


def _open(holds: Sequence[Hold]) -> list[Hold]:
    return [h for h in holds if h.is_open]


# -- money --------------------------------------------------------------------------------------------------


def closed_pnl(hold: Hold) -> float:
    assert hold.exit_price is not None
    return pnl(hold, hold.exit_price)


def gap_usd(hold: Hold, first_price: float, prior_close: float) -> float:
    """The overnight gap of a carried hold: the first revealed regular-session price against the prior close."""
    return round(hold.sign * (first_price - prior_close) * hold.shares, 2)


def free_cash(balance_at_day_start: float, realized_today: float, open_holds: Sequence[Hold]) -> float:
    """Cash not tied up by open holds. Shorts are cash-secured, so a short's notional counts like a long's."""
    return round(balance_at_day_start + realized_today - sum(h.notional for h in _open(open_holds)), 2)


def day_attribution(*, realized_credit: float, unrealized_start: float, unrealized_end: float, gap: float):
    """One day's equity change split three ways (02p b3): realized (holds credited to the ledger today), the overnight
    gap of the carried holds, and the intraday remainder. `realized + unrealized change` is the equity change."""
    unrealized_change = unrealized_end - unrealized_start
    equity_change = realized_credit + unrealized_change
    return {
        "realized_usd": round(realized_credit, 2),
        "gap_usd": round(gap, 2),
        "intraday_usd": round(equity_change - gap, 2),
        "unrealized_change_usd": round(unrealized_change, 2),
        "equity_change_usd": round(equity_change, 2),
    }


# -- the stop rule and sizing -------------------------------------------------------------------------------


def check_stop(hold_side: Side, stop_price: float, last_price: float | None) -> None:
    """A stop sits on the losing side of the last price (the same sentences as `session._check_stop_side`)."""
    if last_price is None:
        return
    if hold_side == "long" and stop_price >= last_price:
        raise HoldProblem("A long stop goes below the last price", path="stopPrice")
    if hold_side == "short" and stop_price <= last_price:
        raise HoldProblem("A short stop goes above the last price", path="stopPrice")


def sizing_hint(*, risk_usd: float | None, last: float, stop: float, free_cash_usd: float) -> int | None:
    """Shares that risk `risk_usd` between `last` and `stop`, capped by free cash. A hint only: None when there is
    nothing to size from or the answer is under one share."""
    if not risk_usd or last <= 0 or last == stop:
        return None
    shares = min(floor(risk_usd / abs(last - stop)), floor(free_cash_usd / last))
    return shares if shares >= 1 else None


# -- state changes ------------------------------------------------------------------------------------------


def exit_hold(hold: Hold, *, day: date, at: pd.Timestamp, price: float, source: Literal["her", "auto"]) -> Hold:
    _require_open(hold, "No open practice hold to exit")
    return replace(hold, status="closed", exit_day=day, exit_at=at, exit_price=price, exit_source=source)


def mark_close(hold: Hold, close: float, day: date) -> Hold:
    """The hold's overnight value: the official close of `day`. A closed hold is not marked."""
    return replace(hold, last_close=close, last_close_day=day) if hold.is_open else hold


def set_stop(hold: Hold, price: float) -> Hold:
    """A new stop note: moves the line and clears the pause flag. `stop_at_entry` (the R basis) never changes."""
    _require_open(hold, "Open a practice hold before setting a stop")
    return replace(hold, stop_price=price, stop_hit_at=None)
