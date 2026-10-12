"""Settles Desk AI calls 90 trading sessions after they were made (02h section 3): each call is
scored against SPY using only its own and SPY's price series, so settlement is a pure function of
its inputs. Phase 5 runs it as a daily job that persists each `Outcome` once — an insert-once (or
upsert keyed by the call) into `ai_call_outcomes` — so a call settles once however many times this
job re-runs; `settle`/`settle_all` do not do that writing, they only compute the value to write.
"""

from dataclasses import dataclass
from datetime import date
from typing import Literal

import exchange_calendars as xcals
import pandas as pd

HORIZON_DAYS = 90
HOLD_BAND_PCT = 5.0  # a Hold succeeds within +/-5% of SPY's return, inclusive
CALIBRATION_BUCKETS = (50.0, 60.0, 70.0, 80.0)  # "50-60", "60-70", "70-80", "80+"; below 50 is "<50"

_CALENDAR = xcals.get_calendar("XNYS")  # the horizon is 90 XNYS trading sessions, not 90 rows

Rating = Literal["buy", "hold", "sell"]
PendingReason = str  # "not_matured", "missing_price_data", or "no price data for <symbol>"


@dataclass(frozen=True)
class AiCall:
    symbol: str
    call_date: date  # must be an XNYS trading session
    rating: Rating
    confidence: float  # 0-100
    base_target: float


@dataclass(frozen=True)
class Outcome:
    call: AiCall
    settle_date: date
    excess_return_pct: float  # the symbol's return minus SPY's, over the horizon
    success: bool
    target_hit: bool | None  # None when the target window's high/low coverage is incomplete
    target_hit_reason: str | None  # set only when target_hit is None
    calibration_bucket: str


@dataclass(frozen=True)
class Pending:
    """`call` is not settled yet: its horizon has not closed as of `as_of` ("not_matured"), its
    symbol has no entry in the `prices` map passed to `settle_all` ("no price data for
    <symbol>"), or `prices`/`spy` has a gap on `call_date` or the settle date
    ("missing_price_data") — never a `KeyError`. A later re-run with fuller data or a later
    `as_of` may settle it."""

    call: AiCall
    reason: PendingReason


def calibration_bucket(confidence: float) -> str:
    if confidence < CALIBRATION_BUCKETS[0]:
        return "<50"
    for low in reversed(CALIBRATION_BUCKETS):
        if confidence >= low:
            return "80+" if low == CALIBRATION_BUCKETS[-1] else f"{low:.0f}-{low + 10:.0f}"
    raise AssertionError("unreachable")  # confidence >= 50 always matches a bucket above


def _success(rating: Rating, excess_return_pct: float) -> bool:
    if rating == "buy":
        return excess_return_pct > 0
    if rating == "sell":
        return excess_return_pct < 0
    return abs(excess_return_pct) <= HOLD_BAND_PCT


def _target_hit(
    call: "AiCall", prices: pd.DataFrame, entry_price: float, settle_date: date
) -> tuple[bool | None, str | None]:
    """Whether `prices` reaches `call.base_target` in the sessions strictly after `call.call_date`
    through `settle_date` — the call was made after that day's close, so it cannot itself register
    a touch. A target above the entry price needs a high at or above it; one below needs a low at
    or below it. Any session in that window missing a high or a low (absent, or `NaN`) makes the
    answer unknown rather than wrong.
    """
    window_start = _CALENDAR.next_session(pd.Timestamp(call.call_date))
    sessions = [d.date() for d in _CALENDAR.sessions_in_range(window_start, pd.Timestamp(settle_date))]
    for d in sessions:
        if d not in prices.index or pd.isna(prices.loc[d, "high"]) or pd.isna(prices.loc[d, "low"]):
            return None, f"missing high/low for {d.isoformat()}"
    window = prices.loc[sessions]
    if call.base_target >= entry_price:
        return bool((window["high"] >= call.base_target).any()), None
    return bool((window["low"] <= call.base_target).any()), None


def settle(call: AiCall, prices: pd.DataFrame | None, spy: pd.Series, as_of: date) -> Outcome | Pending:
    """`call`'s outcome once its 90-trading-session horizon has matured as of `as_of`, else
    `Pending`. `prices` is daily OHLC bars for `call.symbol` indexed by trading day (the same
    shape as `core/backtest.py`'s `bars_1d`: at least `close`, `high`, `low`), or `None` when the
    caller has no data for the symbol at all; `spy` is SPY's closes, indexed the same way. The
    horizon is counted on the XNYS calendar, not on either series' own rows, so a gap in either on
    `call.call_date` or the settle date leaves the call `Pending("missing_price_data")` rather
    than raising. A target window with incomplete high/low coverage settles the excess-return
    verdict anyway (it needs only its two endpoints) with `target_hit=None` (see `_target_hit`).

    Idempotent: every input is read-only and the result depends on nothing but them, so settling
    the same call against the same data twice gives the same result.
    """
    if prices is None:
        return Pending(call, f"no price data for {call.symbol}")

    settle_date = _CALENDAR.session_offset(pd.Timestamp(call.call_date), HORIZON_DAYS).date()
    if settle_date > as_of:
        return Pending(call, "not_matured")

    missing_price_row = call.call_date not in prices.index or settle_date not in prices.index
    missing_spy_row = call.call_date not in spy.index or settle_date not in spy.index
    if missing_price_row or missing_spy_row:
        return Pending(call, "missing_price_data")

    entry_price, exit_price = float(prices.loc[call.call_date, "close"]), float(prices.loc[settle_date, "close"])
    entry_spy, exit_spy = float(spy.loc[call.call_date]), float(spy.loc[settle_date])
    if any(pd.isna(v) for v in (entry_price, exit_price, entry_spy, exit_spy)):
        return Pending(call, "missing_price_data")

    stock_return = exit_price / entry_price - 1
    spy_return = exit_spy / entry_spy - 1
    # Rounded before it meets the Hold threshold, so an exact +/-5% is not missed to binary
    # floating point (the same convention as covered_calls.py's `_r`).
    excess_return_pct = round((stock_return - spy_return) * 100, 6)

    target_hit, target_hit_reason = _target_hit(call, prices, entry_price, settle_date)

    return Outcome(
        call=call,
        settle_date=settle_date,
        excess_return_pct=excess_return_pct,
        success=_success(call.rating, excess_return_pct),
        target_hit=target_hit,
        target_hit_reason=target_hit_reason,
        calibration_bucket=calibration_bucket(call.confidence),
    )


def settle_all(calls: list[AiCall], prices: dict[str, pd.DataFrame], spy: pd.Series, as_of: date) -> list[Outcome]:
    """Every call in `calls` whose horizon has matured as of `as_of` and whose data was complete;
    anything still `Pending` (including a symbol with no entry in `prices`) is simply absent,
    never a placeholder and never a `KeyError`, so re-running this after the next price update
    settles only what newly matured or newly got its data ("catch-up", never skipped)."""
    out = []
    for call in calls:
        result = settle(call, prices.get(call.symbol), spy, as_of)
        if isinstance(result, Outcome):
            out.append(result)
    return out
