"""Position rules shared by every practice thread: the `Hold` value, its money, its split restatement, the cash rule and
the stop crossing, plus the one price every surface marks a position at (`mark_at`, ADR-0025 R8) and the split events
of a span of days (`split_events`). Pure except those two, which read bars through `History` and the blob store: no
database, no clock.

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

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from math import floor
from typing import Any, Literal

import pandas as pd

from ai_trading.core.calendar import ET, next_session, previous_session
from ai_trading.core.calendar import session as trading_session

log = logging.getLogger(__name__)

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


# -- the one price ----------------------------------------------------------------------------------------------------

SPLIT_PART = "split"  # the blob part that holds a name's split-adjusted daily frame through a day
LOOKBACK_SESSIONS_FOR_PRICE = 5  # how many sessions back a name with no print at all is searched for its last one


def data_day(at: pd.Timestamp) -> date:
    """The data day of a thread time: the latest trading session whose regular open is at or before `at`. A weekend, a
    holiday and the pre-market before 9:30 belong to the previous session (the pre-market tape is hidden until the
    open, ADR-0025 D8)."""
    local = pd.Timestamp(at).tz_convert(ET).date()
    found = trading_session("stock", local)
    return local if found is not None and found.regular_open <= at else previous_session("stock", local)


def next_open(at: pd.Timestamp) -> pd.Timestamp:
    """The first regular open (9:30 ET) strictly after `at`: today's when `at` is before it on a trading day, else the
    next trading day's. A weekend or a holiday lands on the next session (ADR-0025 R6)."""
    local = pd.Timestamp(at).tz_convert(ET).date()
    found = trading_session("stock", local)
    if found is not None and at < found.regular_open:
        return found.regular_open
    following = trading_session("stock", next_session("stock", local))
    assert following is not None
    return following.regular_open


@dataclass(frozen=True)
class MarkPrice:
    """A name's mark at a thread time: whole cents, when it printed, and the data day it was read from."""

    price: float
    at: pd.Timestamp
    day: date


def mark_at(
    svc: Any,
    store: Any,
    symbol: str,
    at: pd.Timestamp,
    *,
    feed: str = "sip",
    minutes: int = 1,
    tape: Any = None,
) -> MarkPrice | None:
    """THE price of a name at thread time `at` (ADR-0025 R8): the `data_day(at)` prepared series' quote (the last print
    at or before `at`, else the last closed minute), falling back to the previous session's last print when that day
    has no closed bar yet (`at` = 09:30:00, a day with no trades), up to `LOOKBACK_SESSIONS_FOR_PRICE` sessions back.
    Never the entry price, never a close. None when the name has no price at all (the caller carries it at cost).
    `svc` is `session.Services`; `tape` replaces its tape lookup (a test)."""
    from ai_trading_common.errors import ProviderError

    from ai_trading.replay.data import ReplayDayError

    day = data_day(at)
    for _ in range(LOOKBACK_SESSIONS_FOR_PRICE):
        try:
            inputs = svc.history.day_inputs(store, symbol, day)
        except ReplayDayError:  # no trades that day (a halt, a holiday for this name): look at the session before
            day = previous_session("stock", day)
            continue
        series = svc.history.series.get(inputs, minutes)

        def last_print(through: pd.Timestamp, _day: date = day) -> tuple[pd.Timestamp, float] | None:
            if feed == "off":
                return None
            try:
                return (tape or svc.tape).last_print(store, symbol, through, feed)
            except ProviderError as exc:  # a tape outage reads as no print
                log.warning("tape unavailable for the mark of %s: %s", symbol, exc)
                return None

        found = series.quote(at, last_print)
        if found is not None:
            return MarkPrice(found.price, found.at, day)
        day = previous_session("stock", day)
    return None


# -- splits -----------------------------------------------------------------------------------------------------------


def split_frame(history: Any, store: Any, symbol: str, first_day: date, last_day: date) -> pd.DataFrame:
    """The split-adjusted daily frame through `last_day`, from the blob cache (fetched and stored once; an empty frame
    is stored too, so a name without data is asked about once)."""
    from ai_trading.replay.cache import BlobKey, decode_daily, encode_daily

    key = BlobKey("bars1d", symbol, last_day, SPLIT_PART, "sip")
    payload = store.get(key)
    if payload is not None:
        return decode_daily(payload)
    frame = history.split_daily(symbol, first_day, last_day)
    stored, raw_bytes = encode_daily(frame)
    store.put(key, stored, len(frame), raw_bytes)
    return frame


def split_events(
    history: Any, store: Any, symbol: str, first_day: date, last_day: date
) -> list[tuple[date, float]]:
    """`(ex-date, k)` of every split that took effect on a trading day in `[first_day, last_day]`, oldest first: `k` is
    the ratio of the raw-to-adjusted close of the prior session over the same ratio of the day itself (`split_factor`).
    A corporate action is known before the open, so only the day's own ratio is read. A day without both bars is
    skipped (bad data is not a split)."""
    raw = history.daily_bars(store, symbol, last_day)
    adjusted = split_frame(history, store, symbol, first_day, last_day)
    out: list[tuple[date, float]] = []
    day = first_day
    while day <= last_day:
        if trading_session("stock", day) is not None:
            prior = previous_session("stock", day)
            if all(d in frame.index for frame in (raw, adjusted) for d in (prior, day)):
                closes = [float(raw.loc[prior, "close"]), float(adjusted.loc[prior, "close"])]
                closes += [float(raw.loc[day, "close"]), float(adjusted.loc[day, "close"])]
                if all(close > 0 for close in closes) and (k := split_factor(*closes)) != 1.0:
                    out.append((day, k))
        day = (pd.Timestamp(day) + pd.Timedelta(days=1)).date()
    return out
