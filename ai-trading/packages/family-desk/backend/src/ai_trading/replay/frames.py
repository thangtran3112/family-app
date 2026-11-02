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
from ai_trading.core.indicators import ema, macd, rsi, session_vwap
from ai_trading.replay.journal import fill_price

log = logging.getLogger(__name__)

MINUTE = pd.Timedelta(minutes=1)
LRU_SERIES = 128  # prepared series kept (a series is about 0.5 MB: see the measurement in the A7 commit)

LastPrint = Callable[[pd.Timestamp], tuple[pd.Timestamp, float] | None]  # `through` -> (print time, price) or None

#: The indicator block of a payload (the replay chart's overlays and panes and the left rail): EMA 9 and 21, the session
#: VWAP, RSI 14 and MACD (12, 26, 9). Every one is causal: a value depends only on bars up to its own, so a cut of the
#: whole-series arrays at T is exactly the indicator of the bars closed by T (`test_frames.py` fails the build for one
#: that is not). A value that has not warmed up is NaN here and null in the payload, never filled.
INDICATORS = ("ema9", "ema21", "vwap", "rsi14", "macd", "macd_signal", "macd_hist")


def indicator_columns(close: pd.Series, vwap: np.ndarray) -> pd.DataFrame:
    """The indicator columns over `close` (display-bar closes) and `vwap` (the session VWAP read onto each bar)."""
    line = macd(close, 12, 26, 9)
    return pd.DataFrame(
        {
            "ema9": ema(close, 9),
            "ema21": ema(close, 21),
            "vwap": vwap,
            "rsi14": rsi(close, 14),
            "macd": line.line,
            "macd_signal": line.signal,
            "macd_hist": line.histogram,
        },
        index=close.index,
    )


def _rows(index: pd.Index, frame: pd.DataFrame) -> list[dict[str, Any]]:
    """`{t, <indicator>...}` per row, NaN as None."""
    columns = {name: frame[name].astype(object).where(frame[name].notna(), None).tolist() for name in INDICATORS}
    return [{"t": t, **{name: columns[name][i] for name in INDICATORS}} for i, t in enumerate(index)]


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
    indicators: dict[str, Any] | None  # {"interval", "as_of_bar", "rows"} for every bar of `bars` plus the forming one


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
        # built on first use; private (they cover the whole day)
        self._ind: pd.DataFrame | None = None  # indicators of every display bar
        self._vwap: tuple[np.ndarray, np.ndarray] | None = None  # (minute starts ns, session VWAP as of each minute)

    # -- construction ----------------------------------------------------------------------------------------

    def _ends(self, display: pd.DataFrame) -> np.ndarray:
        """When each display bar's period ends (it is exposed once T has reached it): the bin's end, capped at the end
        of its own phase. Non-decreasing, so a cut at T is one binary search."""
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

    def forming(self, through: pd.Timestamp, quote: Quote | None = None) -> dict[str, Any] | None:
        """The display bar now forming, built from closed minutes of the same phase bin (None on a bin boundary). With a
        `quote` printed inside the bin it takes the quote as its close and widens its high and low to include it, so the
        candle, the header price and the indicators read one number."""
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
        high, low, close = float(part["high"].max()), float(part["low"].min()), float(part["close"].iloc[-1])
        if quote is not None and quote.at >= bin_start:
            high, low, close = max(high, quote.price), min(low, quote.price), quote.price
        return {
            "t": bin_start,
            "o": float(part["open"].iloc[0]),
            "h": high,
            "l": low,
            "c": close,
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
        and one exists at or before `through`; else the last closed 1-minute bar's close, stamped with its close
        time."""
        through = self._clamp(through)
        if last_print is not None:
            found = last_print(through)
            if found is not None:
                return Quote(fill_price(found[1]), found[0])
        closed = self.closed_minutes(through)
        if closed.empty:
            return None
        return Quote(fill_price(float(closed["close"].iloc[-1])), closed.index[-1] + MINUTE)

    # -- indicators ------------------------------------------------------------------------------------------

    def _minute_vwap(self) -> tuple[np.ndarray, np.ndarray]:
        """The session VWAP as of each 1-minute bar (NaN outside the regular session), whatever the display interval
        (D-168). Causal, so computed once for the whole series and only ever read below T."""
        if self._vwap is None:
            ann = annotate(self._minutes, "stock") if len(self._minutes) else self._minutes.assign(day=None, phase=None)
            if ann.empty:
                self._vwap = (np.array([], dtype="int64"), np.array([], dtype="float64"))
            else:
                self._vwap = (ann.index.asi8, session_vwap(ann).to_numpy(dtype="float64"))
        return self._vwap

    def _closed_indicators(self) -> pd.DataFrame:
        """Indicators of every display bar (private). A bar reads the VWAP as of the last minute inside it."""
        if self._ind is None:
            display = self._display
            starts, values = self._minute_vwap()
            if len(starts):
                last = np.searchsorted(starts, self._end_ns, side="left") - 1
                inside = (last >= 0) & (starts[np.clip(last, 0, None)] >= display.index.asi8)
                vwap = np.where(inside, values[np.clip(last, 0, None)], np.nan)
            else:
                vwap = np.full(len(display), np.nan)
            self._ind = indicator_columns(display["close"], vwap)
        return self._ind

    def indicators(
        self, bars: pd.Index, forming: dict[str, Any] | None, through: pd.Timestamp, interval: str
    ) -> dict[str, Any] | None:
        """The indicator block for `bars` (the start times of display bars closed by `through`, all of them for a feed
        or the new ones of an advance) plus the forming candle. Closed rows are slices of the whole-series arrays
        (causality makes that the indicator of the bars closed by `through`); the forming row is computed over the
        closed bars plus the forming candle, so it moves with the price. `as_of_bar` is the last bar included. None
        without any bar."""
        through = self._clamp(through)
        stop = int(np.searchsorted(self._end_ns, through.value, side="right"))
        if stop == 0 and forming is None:
            return None
        rows = _rows(bars, self._closed_indicators().loc[bars]) if len(bars) else []
        as_of = self._display.index[stop - 1] if stop else None
        if forming is not None:
            rows.append({"t": forming["t"], **self._forming_indicators(stop, forming, through)})
            as_of = forming["t"]
        return {"interval": interval, "as_of_bar": as_of, "rows": rows}

    def _forming_indicators(self, stop: int, forming: dict[str, Any], through: pd.Timestamp) -> dict[str, Any]:
        closes = pd.Series(np.append(self._display["close"].to_numpy(dtype="float64")[:stop], forming["c"]))
        starts, values = self._minute_vwap()
        vwap = np.full(len(closes), np.nan)
        last = int(np.searchsorted(starts, (through - MINUTE).value, side="right")) - 1
        if last >= 0 and starts[last] >= forming["t"].value:
            vwap[-1] = values[last]
        tail = indicator_columns(closes, vwap).iloc[-1]
        return {name: None if np.isnan(tail[name]) else float(tail[name]) for name in INDICATORS}

    def at(self, through: pd.Timestamp, last_print: LastPrint | None = None, interval: str = "") -> Cut:
        """Everything a screen reads of the name at `through`, cut once at `min(through, tape_end)`."""
        through = self._clamp(through)
        quote = self.quote(through, last_print)
        bars, forming = self.bars(through), self.forming(through, quote)
        return Cut(
            through=through,
            bars=bars,
            forming=forming,
            quote=quote,
            levels=self.levels(through),
            indicators=self.indicators(bars.index, forming, through, interval),
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
