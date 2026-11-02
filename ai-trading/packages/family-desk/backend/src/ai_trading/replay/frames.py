"""Prepared bars for one (symbol, day, interval), and the one price function every surface prices a name with.

**One series, one cut.** A `PreparedSeries` holds a name's 1-minute bars (the day and its lookback sessions, from
`History.day_inputs`) and the whole display-interval series, aggregated once with the engine's own `_resample`. A
request never re-resamples: it slices at the thread time T. The whole day lives only inside this object; its only exits
are `at(T)`, `bars_between` and `quote`, which return copies or values cut at `min(T, tape_end)`, so nothing past T can
leave the server (no public frame attribute, no serializer for the whole series). Every indicator added to `Cut`
must be causal (a value depends only on bars up to its own); `tests/replay/test_thread_time_sync.py` fails the build
for one that is not.

**One price.** `PreparedSeries.quote(T, last_print)` is the only place a name is priced at T: the last eligible print
at or before T when the caller serves the name's tape (`last_print`), else the last closed 1-minute bar of the day
(extended hours included), in whole cents. The chart's header and forming candle, the marks, the positions and the
clock's account, and the day list's `live` block all call it. A day-list name without an open position is priced
without a tape (the tape of a name she never opened is not prepared: reading it would be a provider request per name per
read), so its price is the last closed minute's close.

**One cache.** `SeriesCache` is an LRU of prepared series (the decoded bars are `History`'s own, larger LRU of
`DayInputs`). A series is immutable (a finished day never changes), so a hit is always current. `warm` builds the
series of a day's names ahead of the first read: local blob decode work only, never a provider request (the prep
guarantees the blobs).
"""

import logging
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.core.calendar import annotate
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.evaluate import _resample
from ai_trading.replay.journal import fill_price

log = logging.getLogger(__name__)

MINUTE = pd.Timedelta(minutes=1)
LRU_SERIES = 128  # prepared series kept (a series is about 0.5 MB: see the measurement in the A7 commit)

LastPrint = Callable[[pd.Timestamp], tuple[pd.Timestamp, float] | None]  # `through` -> (print time, price) or None


@dataclass(frozen=True)
class Quote:
    """A name's price at a thread time: whole cents, and when it was printed or its 1-minute bar closed."""

    price: float
    at: pd.Timestamp


@dataclass(frozen=True)
class Cut:
    """What a name looks like at T, every part cut at `through = min(T, tape_end)`."""

    through: pd.Timestamp
    bars: pd.DataFrame  # display bars whose period has closed by `through` (lookback sessions included)
    forming: dict[str, Any] | None
    quote: Quote | None
    levels: dict[str, Any]


def tape_end(day: date) -> pd.Timestamp:
    """The last instant a day has bars: the extended close, the same for every name of the day."""
    found = trading_session("stock", day)
    assert found is not None
    return found.extended_close


def market_block(
    day: date, thread_time: pd.Timestamp, last_bar_at: pd.Timestamp | None, next_open_at: pd.Timestamp | None
) -> dict[str, Any]:
    """The exchange's state at the thread time T (uncapped) for the day the thread is on: which phase the session is
    in, when the day's tape ends, when the last bar closed (None where the payload names no single name) and when the
    next trading day's data starts (the day hands over there). "closed" is the night, the weekend, a holiday: the
    day has no bars after its extended close, and none of them is carried across the gap."""
    found = trading_session("stock", day)
    assert found is not None
    if found.extended_open <= thread_time < found.regular_open:
        phase = "premarket"
    elif found.regular_open <= thread_time < found.regular_close:
        phase = "regular"
    elif found.regular_close <= thread_time < found.extended_close:
        phase = "after_hours"
    else:
        phase = "closed"
    return {"phase": phase, "tape_end": found.extended_close, "last_bar_at": last_bar_at, "next_open_at": next_open_at}


class PreparedSeries:
    """One (symbol, day, interval): see the module docstring. Built from the day's `DayInputs`; immutable."""

    def __init__(self, symbol: str, day: date, width: int, minutes: pd.DataFrame, prior_close: float | None) -> None:
        found = trading_session("stock", day)
        assert found is not None
        self.symbol, self.day, self.width = symbol, day, width
        self.tape_end = found.extended_close
        self.prior_close = prior_close
        self._found = found
        self._minutes = minutes  # UTC bar-start index, ascending; lookback sessions then the day
        self._day_from = int(minutes.index.searchsorted(found.extended_open, side="left"))
        ann = annotate(minutes, "stock") if len(minutes) else minutes.assign(day=None, phase=None)
        display = ann if width == 1 or ann.empty else _resample(ann, "stock", width, self.tape_end)
        self._display = display
        self._end_ns = self._ends(display)
        self.memo: dict[str, Any] = {}  # per-series caches of the callers (the as-of daily frame, the live metric rows)

    # -- construction ----------------------------------------------------------------------------------------

    def _ends(self, display: pd.DataFrame) -> np.ndarray:
        """When each display bar's period ends (it is exposed once T has reached it): the bin's end, capped at the end
        its own phase. Non-decreasing, so a cut at T is one binary search."""
        if display.empty:
            return np.array([], dtype="int64")
        caps: dict[tuple[date, str], int] = {}
        out = np.empty(len(display), dtype="int64")
        width_ns = int(pd.Timedelta(minutes=self.width).value)
        for i, (start, day, phase) in enumerate(zip(display.index.asi8, display["day"], display["phase"], strict=True)):
            key = (day, phase)
            if key not in caps:
                found = trading_session("stock", day)
                assert found is not None
                caps[key] = int(
                    {"pre": found.regular_open, "regular": found.regular_close, "post": found.extended_close}[
                        phase
                    ].value
                )
            out[i] = min(start + width_ns, caps[key])
        return out

    # -- cuts ------------------------------------------------------------------------------------------------

    def _clamp(self, through: pd.Timestamp) -> pd.Timestamp:
        return min(through, self.tape_end)

    def closed_minutes(self, through: pd.Timestamp) -> pd.DataFrame:
        """Closed 1-minute bars of the day (extended hours) at `through`, nothing later (a view: do not mutate)."""
        high = int(self._minutes.index.searchsorted(self._clamp(through) - MINUTE, side="right"))
        return self._minutes.iloc[self._day_from : max(high, self._day_from)]

    def minutes_through(self, through: pd.Timestamp) -> pd.DataFrame:
        """Every 1-minute bar closed by `through`, the lookback sessions included (what a metric row reads): a view."""
        high = int(self._minutes.index.searchsorted(self._clamp(through) - MINUTE, side="right"))
        return self._minutes.iloc[:high]

    def last_bar_close(self, through: pd.Timestamp) -> pd.Timestamp | None:
        """When the last 1-minute bar closed by `through` closed (None before the day's first bar)."""
        closed = self.closed_minutes(through)
        return None if closed.empty else closed.index[-1] + MINUTE

    def bars(self, through: pd.Timestamp) -> pd.DataFrame:
        """Display bars whose period has closed by `through`, with the lookback sessions: a copy."""
        stop = int(np.searchsorted(self._end_ns, self._clamp(through).value, side="right"))
        return self._display.iloc[:stop].copy()

    def bars_between(self, previous: pd.Timestamp, through: pd.Timestamp) -> pd.DataFrame:
        """Display bars that closed inside `(previous, through]`: what an advance reveals."""
        lo = int(np.searchsorted(self._end_ns, self._clamp(previous).value, side="right"))
        hi = int(np.searchsorted(self._end_ns, self._clamp(through).value, side="right"))
        return self._display.iloc[lo : max(hi, lo)].copy()

    def forming(self, through: pd.Timestamp) -> dict[str, Any] | None:
        """The display bar now forming, built from closed minutes of the same phase bin (None on a bin boundary)."""
        through = self._clamp(through)
        minutes = self.closed_minutes(through)
        if minutes.empty:
            return None
        found, last = self._found, minutes.index[-1]
        phase = "pre" if last < found.regular_open else "regular" if last < found.regular_close else "post"
        start_of = {"pre": found.extended_open, "regular": found.regular_open, "post": found.regular_close}[phase]
        end_of = {"pre": found.regular_open, "regular": found.regular_close, "post": found.extended_close}[phase]
        width = pd.Timedelta(minutes=self.width)
        bin_start = start_of + ((last - start_of) // width) * width
        bin_end = min(bin_start + width, end_of)
        if bin_end <= through:
            return None
        part = minutes[(minutes.index >= bin_start)]
        if part.empty:
            return None
        return {
            "t": bin_start,
            "o": float(part["open"].iloc[0]),
            "h": float(part["high"].max()),
            "l": float(part["low"].min()),
            "c": float(part["close"].iloc[-1]),
            "v": float(part["volume"].sum()),
        }

    def levels(self, through: pd.Timestamp) -> dict[str, Any]:
        """The levels a trader reads at `through`: the prior close and the regular session's range and opening range."""
        through = self._clamp(through)
        found = self._found
        minutes = self.closed_minutes(through)
        regular = minutes[(minutes.index >= found.regular_open) & (minutes.index < found.regular_close)]
        out: dict[str, Any] = {"prior_close": self.prior_close}
        if len(regular):
            out["session_high"] = float(regular["high"].max())
            out["session_low"] = float(regular["low"].min())
        if through >= found.regular_open + pd.Timedelta(minutes=15):
            opening = regular[regular.index < found.regular_open + pd.Timedelta(minutes=15)]
            if len(opening):
                out["opening_range_high"] = float(opening["high"].max())
                out["opening_range_low"] = float(opening["low"].min())
        return out

    def quote(self, through: pd.Timestamp, last_print: LastPrint | None = None) -> Quote | None:
        """The price at `through`: THE price function (module docstring). A print wins when the caller serves the tape
        one exists at or before `through`; else the last closed 1-minute bar's close, stamped with its close time."""
        through = self._clamp(through)
        if last_print is not None:
            found = last_print(through)
            if found is not None:
                return Quote(fill_price(found[1]), found[0])
        closed = self.closed_minutes(through)
        if closed.empty:
            return None
        return Quote(fill_price(float(closed["close"].iloc[-1])), closed.index[-1] + MINUTE)

    def at(self, through: pd.Timestamp, last_print: LastPrint | None = None) -> Cut:
        """Everything a screen reads of the name at `through`, cut once at `min(through, tape_end)`."""
        through = self._clamp(through)
        return Cut(
            through=through,
            bars=self.bars(through),
            forming=self.forming(through),
            quote=self.quote(through, last_print),
            levels=self.levels(through),
        )


class SeriesCache:
    """An LRU of `PreparedSeries` by (symbol, day, interval width). One per `History`."""

    def __init__(self, size: int = LRU_SERIES) -> None:
        self.size = size
        self._lru: OrderedDict[tuple[str, date, int], PreparedSeries] = OrderedDict()

    def __len__(self) -> int:
        return len(self._lru)

    def get(self, inputs: Any, width: int) -> PreparedSeries:
        """The series of `inputs` (a `DayInputs`) at `width` minutes: the cached one, else built now."""
        key = (inputs.symbol, inputs.day, width)
        if key in self._lru:
            self._lru.move_to_end(key)
            return self._lru[key]
        series = PreparedSeries(inputs.symbol, inputs.day, width, inputs.bars_1m, inputs.prior_close)
        self._lru[key] = series
        while len(self._lru) > self.size:
            self._lru.popitem(last=False)
        return series


def warm(history: Any, store: Any, symbols: list[str], day: date, width: int) -> int:
    """Prepare the series of every name at `width`, so the first read of a day is a slice. A name whose bars are not
    there (no trades that day, a blob missing) is skipped: its first read says so. Returns how many were prepared."""
    from ai_trading_common.errors import ProviderError

    from ai_trading.replay.data import ReplayDayError

    done = 0
    for symbol in symbols:
        try:
            history.series.get(history.day_inputs(store, symbol, day), width)
            done += 1
        except (ReplayDayError, ProviderError) as exc:
            log.warning("warm: %s %s not prepared: %s", symbol, day, exc)
    return done
