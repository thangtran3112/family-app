"""The prepared series (`replay/frames.py`): its cuts equal the per-request computation they replaced, nothing past T
leaves it, and every indicator is causal. No database: random-walk minute bars over four sessions, 2026-09-28 last.

The no-lookahead guarantee is tested the way `test_day_list_live.py` tests the list: bend every bar after T to 999 and
assert nothing the cut returns changes (bars, forming candle, price, levels, indicators)."""

import time
from datetime import date

import numpy as np
import pandas as pd
import pytest

from ai_trading.core.calendar import annotate, et, previous_session, session
from ai_trading.core.evaluate import _resample
from ai_trading.replay import frames

DAY = date(2026, 9, 28)
MINUTE = pd.Timedelta(minutes=1)


def _minutes(seed: int, *, sessions: int = 4, start: float = 100.0) -> pd.DataFrame:
    """Random-walk 1-minute bars (extended hours) for `sessions` sessions ending at `DAY`."""
    rng = np.random.default_rng(seed)
    days = [DAY]
    for _ in range(sessions - 1):
        days.insert(0, previous_session("stock", days[0]))
    frames_ = []
    price = start
    for day in days:
        found = session("stock", day)
        index = pd.date_range(found.extended_open, found.extended_close, freq="1min", inclusive="left")
        steps = rng.normal(0, 0.05, len(index))
        close = price + np.cumsum(steps)
        open_ = np.concatenate([[price], close[:-1]])
        spread = np.abs(rng.normal(0, 0.03, len(index)))
        frames_.append(
            pd.DataFrame(
                {
                    "open": open_,
                    "high": np.maximum(open_, close) + spread,
                    "low": np.minimum(open_, close) - spread,
                    "close": close,
                    "volume": rng.integers(100, 5000, len(index)).astype(float),
                },
                index=index,
            )
        )
        price = float(close[-1])
    return pd.concat(frames_)


def _series(minutes: pd.DataFrame, width: int = 5) -> frames.PreparedSeries:
    return frames.PreparedSeries("X", DAY, width, minutes, 100.0)


def _times(seed: int, count: int) -> list[pd.Timestamp]:
    """Cut times across the day, on and off bar boundaries, from the open of its extended session to the night."""
    found = session("stock", DAY)
    rng = np.random.default_rng(seed)
    span = (found.extended_close - found.extended_open).total_seconds()
    return [found.extended_open + pd.Timedelta(seconds=float(s)) for s in rng.uniform(0, span + 3 * 3600, count)]


# -- the cuts equal what a request used to compute ------------------------------------------------------------------


def _old_bars(minutes: pd.DataFrame, through: pd.Timestamp, width: int) -> pd.DataFrame:
    closed = minutes[minutes.index + MINUTE <= through]
    if closed.empty:
        return closed.assign(day=None, phase=None)
    return _resample(annotate(closed, "stock"), "stock", width, through)


@pytest.mark.parametrize("width", [1, 5, 15])
def test_the_display_bars_at_t_equal_a_fresh_resample_of_the_closed_minutes(width: int) -> None:
    minutes = _minutes(1)
    series = _series(minutes, width)
    for through in _times(2, 40):
        expected = _old_bars(minutes, min(through, series.tape_end), width)
        pd.testing.assert_frame_equal(series.bars(through), expected, check_freq=False)


@pytest.mark.parametrize("width", [1, 5])
def test_bars_between_are_the_bars_that_closed_inside_the_interval(width: int) -> None:
    minutes = _minutes(3)
    series = _series(minutes, width)
    times = sorted(_times(4, 30))
    for previous, through in zip(times, times[1:], strict=False):
        now = _old_bars(minutes, min(through, series.tape_end), width)
        before = set(_old_bars(minutes, min(previous, series.tape_end), width).index)
        expected = now[[t not in before for t in now.index]]
        pd.testing.assert_frame_equal(series.bars_between(previous, through), expected, check_freq=False)


def _old_forming(minutes: pd.DataFrame, through: pd.Timestamp, width: int) -> dict | None:
    """The forming candle as `session._forming` built it before the series."""
    found = session("stock", DAY)
    closed = minutes[(minutes.index >= found.extended_open) & (minutes.index + MINUTE <= through)]
    if closed.empty:
        return None
    last = closed.index[-1]
    phase = "pre" if last < found.regular_open else "regular" if last < found.regular_close else "post"
    start_of = {"pre": found.extended_open, "regular": found.regular_open, "post": found.regular_close}[phase]
    end_of = {"pre": found.regular_open, "regular": found.regular_close, "post": found.extended_close}[phase]
    step = pd.Timedelta(minutes=width)
    bin_start = start_of + ((last - start_of) // step) * step
    if min(bin_start + step, end_of) <= through:
        return None
    part = closed[closed.index >= bin_start]
    return {
        "t": bin_start,
        "o": float(part["open"].iloc[0]),
        "h": float(part["high"].max()),
        "l": float(part["low"].min()),
        "c": float(part["close"].iloc[-1]),
        "v": float(part["volume"].sum()),
    }


@pytest.mark.parametrize("width", [1, 5, 15])
def test_the_forming_candle_equals_the_one_built_from_closed_minutes(width: int) -> None:
    minutes = _minutes(5)
    series = _series(minutes, width)
    for through in _times(6, 40):
        through = min(through, series.tape_end)
        assert series.forming(through) == _old_forming(minutes, through, width), through


def test_a_quote_inside_the_forming_bin_closes_the_candle_and_widens_it_and_an_old_one_does_not() -> None:
    minutes = _minutes(7)
    series = _series(minutes, 5)
    through = et(DAY, "10:12:30")  # inside the 10:10 bin, after the 10:11 minute closed
    plain = series.forming(through)
    assert plain is not None and plain["t"] == et(DAY, "10:10")
    printed = series.forming(through, frames.Quote(plain["h"] + 1.0, et(DAY, "10:12:10")))
    assert printed["c"] == plain["h"] + 1.0 and printed["h"] == plain["h"] + 1.0 and printed["l"] == plain["l"]
    stale = series.forming(through, frames.Quote(plain["h"] + 1.0, et(DAY, "10:04:00")))  # printed before the bin
    assert stale == plain


# -- no lookahead -----------------------------------------------------------------------------------------------------


def _everything(cut: frames.Cut) -> tuple:
    return (cut.through, cut.bars.to_dict("list"), cut.forming, cut.quote, cut.levels, cut.indicators)


@pytest.mark.parametrize("width", [1, 5])
def test_bending_every_bar_after_t_changes_nothing_a_cut_returns(width: int) -> None:
    minutes = _minutes(8)
    for through in _times(9, 12):
        bent = minutes.copy()
        later = (bent.index + MINUTE > through) & (bent.index >= et(DAY, "04:00"))  # a bar not closed by T, today's
        bent.loc[later, ["open", "high", "low", "close"]] = 999.0
        original, altered = _series(minutes, width).at(through, interval="5m"), _series(bent, width).at(through)
        assert _everything(original)[:5] == _everything(altered)[:5], through
        assert original.indicators["rows"] == _series(bent, width).at(through, interval="5m").indicators["rows"]
        assert max(original.bars["high"], default=0.0) < 999.0


# -- causality (I6): a later bar never changes an earlier indicator --------------------------------------------------


@pytest.mark.parametrize("width", [1, 5, 15])
def test_every_indicator_is_causal_through_the_whole_pipeline(width: int) -> None:
    """`indicators(bars[:k])[:k] == indicators(bars)[:k]` for every indicator and random k: the series built from the
    minutes that closed by bar k (annotate, resample, EMA/RSI/MACD, the VWAP read onto bars) gives the same first k rows
    as the series of the whole day. A non-causal indicator (a centred window, a full-day normalisation) fails here."""
    minutes = _minutes(10)
    full = _series(minutes, width)
    everything = full._closed_indicators()
    rng = np.random.default_rng(11)
    for k in sorted(rng.integers(30, len(everything), 12)):
        cut_at = pd.Timestamp(int(full._end_ns[k - 1]), tz="UTC")  # bar k-1 has just closed
        part = _series(minutes[minutes.index + MINUTE <= cut_at], width)
        head = part._closed_indicators().iloc[:k]
        assert list(head.columns) == list(frames.INDICATORS)
        np.testing.assert_allclose(
            head.to_numpy(), everything.iloc[:k].to_numpy(), rtol=1e-12, atol=1e-12, equal_nan=True, err_msg=f"k={k}"
        )


def test_the_indicators_warm_up_to_null_and_a_value_is_never_filled() -> None:
    series = _series(_minutes(12), 5)
    rows = series.at(et(DAY, "04:00") + pd.Timedelta(minutes=20), interval="5m").indicators["rows"]
    # the lookback sessions warm everything up; the first bar of the whole series is the one that has nothing behind it
    first = series.indicators(pd.DatetimeIndex([series._display.index[0]]), None, series.tape_end, "5m")["rows"][0]
    assert first["ema9"] is None and first["ema21"] is None and first["rsi14"] is None and first["macd_signal"] is None
    assert rows[-1]["ema21"] is not None  # three sessions of lookback behind it: warm


def test_the_vwap_reads_as_of_the_last_minute_inside_the_bar_and_only_in_the_regular_session() -> None:
    minutes = _minutes(13)
    series = _series(minutes, 5)
    rows = {r["t"]: r for r in series.at(et(DAY, "11:00"), interval="5m").indicators["rows"]}
    assert rows[et(DAY, "05:00")]["vwap"] is None  # a pre-market bar has no session VWAP
    ann = annotate(minutes, "stock")
    from ai_trading.core.indicators import session_vwap

    expected = session_vwap(ann)[et(DAY, "10:09")]  # the last minute inside the 10:05 bar
    assert rows[et(DAY, "10:05")]["vwap"] == pytest.approx(float(expected))


# -- the budget -------------------------------------------------------------------------------------------------------


def test_a_49_name_cut_with_indicators_stays_inside_the_per_name_budget() -> None:
    """Plan A5: per-name p95 under 50 ms for one cut (bars, forming, price, levels and the indicator rows of every bar
    of the lookback and the day). Warm = the series and its indicator arrays are built; cold = first read of a name."""
    names = [_series(_minutes(100 + i), 1) for i in range(49)]
    through = et(DAY, "13:07:30")
    cold, warm = [], []
    for series in names:
        started = time.perf_counter()
        series.at(through, interval="1m")
        cold.append((time.perf_counter() - started) * 1000)
    for series in names:
        started = time.perf_counter()
        series.at(through, interval="1m")
        warm.append((time.perf_counter() - started) * 1000)
    p95_cold, p95_warm = float(np.percentile(cold, 95)), float(np.percentile(warm, 95))
    print(f"\n[A5 timing] 49 names, 1m cut with indicators: cold p95 {p95_cold:.1f} ms, warm p95 {p95_warm:.1f} ms")
    assert p95_warm < 50 and p95_cold < 50, (p95_cold, p95_warm)
