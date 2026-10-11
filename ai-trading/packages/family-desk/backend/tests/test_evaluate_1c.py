"""Phase 1c part D: the new 02f §3 series blocks, pivot level blocks, the bar_close_5m/15m/1h
cadences, and the Desk Technical Bias series wiring, all inside `evaluate.py`."""

from datetime import date
from typing import Any

import numpy as np
import pandas as pd
import pytest
from bars import minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import bias as bias_module
from ai_trading.core import indicators, pivots
from ai_trading.core.calendar import annotate, et
from ai_trading.core.evaluate import _bias_series, _resample, check, evaluate, label

DAY = date(2026, 10, 6)  # a Tuesday


def make_spec(when: dict[str, Any], run_on: str = "daily_close", session: str = "regular") -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": session, "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )


def wavy_daily(n: int, seed: int = 7) -> pd.DataFrame:
    """Daily OHLCV with a real high/low spread, unlike `bars.daily_bars`'s flat bars: needed to
    exercise range-based indicators (CCI, ADX, Williams %R, pivots) meaningfully."""
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    high = close + np.abs(rng.normal(0.5, 0.2, n))
    low = close - np.abs(rng.normal(0.5, 0.2, n))
    volume = rng.integers(1_000, 5_000, n).astype(float)
    days = trading_days("stock", DAY, n)
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": volume}, index=pd.Index(days)
    )


DAILY = wavy_daily(300)
CLOSE = DAILY["close"]


def first_known(series: pd.Series) -> tuple[date, float]:
    """The first day `series` is known, and its value there -- a condition that is simply "this
    series is known" fires on evaluate()'s rising edge, i.e. the FIRST known bar, not the last."""
    known = series.dropna()
    assert len(known), "series is never known over this window"
    return known.index[0], float(known.iloc[0])


def run_series(operand: dict[str, Any], full: pd.DataFrame, upto: date) -> float:
    """Evaluates `operand` against a condition that fires once known, over `full` trimmed to end
    at `upto` (so the bar it fires on is also the last bar, matching a value computed from the
    same, un-trimmed `full` at that day). Returns the single evidence value."""
    spec = make_spec({"op": "gt", "left": operand, "right": {"value": -1e9}})
    trimmed = full.loc[:upto]
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=trimmed, as_of=et(upto, "20:00"))
    assert len(found) == 1, operand
    [value] = found[0].evidence.values()
    return value


def test_label_evidence_key_pins_the_schema_order():
    # label() doesn't sort anything itself -- it joins operand.items() in whatever order
    # model_dump() hands back. Today that happens to be alphabetical by key name (an artifact of
    # the datamodel-code-generator toolchain, not a guarantee label() makes); this pins the exact
    # key so a silent change in that toolchain's field order is caught here, not in a dashboard.
    operand = {"series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9}
    spec = make_spec({"op": "gt", "left": operand, "right": {"value": 0}})
    dumped = spec.model_dump(by_alias=True, exclude_none=True)["when"]["left"]
    assert dumped == {"fast": 12, "line": "line", "series": "macd", "signal": 9, "slow": 26}
    assert label(dumped) == "macd(12, line, 9, 26)"


SERIES_CASES: dict[str, tuple[dict[str, Any], pd.Series]] = {
    "macd line": ({"series": "macd", "line": "line", "fast": 12, "slow": 26, "signal": 9}, indicators.macd(CLOSE).line),
    "macd signal": (
        {"series": "macd", "line": "signal", "fast": 12, "slow": 26, "signal": 9},
        indicators.macd(CLOSE).signal,
    ),
    "macd histogram": (
        {"series": "macd", "line": "histogram", "fast": 12, "slow": 26, "signal": 9},
        indicators.macd(CLOSE).histogram,
    ),
    "stochastic k": (
        {"series": "stochastic", "line": "k", "length": 14, "smoothK": 3, "smoothD": 3},
        indicators.stochastic(DAILY).k,
    ),
    "stochastic d": (
        {"series": "stochastic", "line": "d", "length": 14, "smoothK": 3, "smoothD": 3},
        indicators.stochastic(DAILY).d,
    ),
    "stoch_rsi k": (
        {"series": "stoch_rsi", "line": "k", "smoothK": 3, "smoothD": 3, "rsiLength": 14, "stochLength": 14},
        indicators.stoch_rsi(CLOSE).k,
    ),
    "stoch_rsi d": (
        {"series": "stoch_rsi", "line": "d", "smoothK": 3, "smoothD": 3, "rsiLength": 14, "stochLength": 14},
        indicators.stoch_rsi(CLOSE).d,
    ),
    "cci": ({"series": "cci", "length": 20}, indicators.cci(DAILY)),
    "adx": ({"series": "adx", "line": "adx", "length": 14}, indicators.adx(DAILY).adx),
    "adx plus_di": ({"series": "adx", "line": "plus_di", "length": 14}, indicators.adx(DAILY).plus_di),
    "adx minus_di": ({"series": "adx", "line": "minus_di", "length": 14}, indicators.adx(DAILY).minus_di),
    "awesome_oscillator": (
        {"series": "awesome_oscillator", "fast": 5, "slow": 34},
        indicators.awesome_oscillator(DAILY),
    ),
    "momentum": ({"series": "momentum", "length": 10}, indicators.momentum(CLOSE, 10)),
    "williams_r": ({"series": "williams_r", "length": 14}, indicators.williams_r(DAILY)),
    "bull_bear_power bull": (
        {"series": "bull_bear_power", "line": "bull", "length": 13},
        indicators.bull_bear_power(DAILY).bull,
    ),
    "bull_bear_power bear": (
        {"series": "bull_bear_power", "line": "bear", "length": 13},
        indicators.bull_bear_power(DAILY).bear,
    ),
    "ultimate_oscillator": (
        {"series": "ultimate_oscillator", "fast": 7, "mid": 14, "slow": 28},
        indicators.ultimate_oscillator(DAILY),
    ),
    "vwma": ({"series": "vwma", "length": 20}, indicators.vwma(DAILY, 20)),
    "hull_ma": ({"series": "hull_ma", "length": 9}, indicators.hull_ma(CLOSE, 9)),
    "ichimoku conversion": (
        {"series": "ichimoku", "line": "conversion", "conversionLength": 9, "baseLength": 26, "spanBLength": 52},
        indicators.ichimoku(DAILY).conversion,
    ),
    "ichimoku span_b": (
        {"series": "ichimoku", "line": "span_b", "conversionLength": 9, "baseLength": 26, "spanBLength": 52},
        indicators.ichimoku(DAILY).span_b,
    ),
    "atr_pct": ({"series": "atr_pct", "length": 14, "medianLength": 100}, indicators.atr_percent(DAILY, 14, 100).pct),
}


@pytest.mark.parametrize("name", sorted(SERIES_CASES))
def test_series_block_matches_the_underlying_indicator(name: str):
    operand, series = SERIES_CASES[name]
    day, expected = first_known(series)
    assert run_series(operand, DAILY, day) == pytest.approx(round(expected, 6))


@pytest.mark.parametrize("method", ["classic", "fibonacci", "camarilla"])
@pytest.mark.parametrize("period", ["session", "week", "month"])
def test_pivot_level_matches_the_underlying_formula(method: str, period: str):
    high, low, close = pivots.prior_period_hlc(DAILY, DAILY.index, "stock", period)
    expected_series = getattr(pivots, f"{method}_pivots")(high, low, close)["R1"]
    day, expected = first_known(expected_series)
    operand = {"level": "pivot", "method": method, "period": period, "point": "R1"}
    assert run_series(operand, DAILY, day) == pytest.approx(round(expected, 6))


# --- the Desk Technical Bias series: warming up, then a point-in-time match -------------------


def test_bias_series_is_entirely_unknown_before_warming_up():
    short = DAILY.iloc[: bias_module.MIN_BARS - 1]
    spec = make_spec({"op": "gt", "left": {"series": "bias", "part": "summary"}, "right": {"value": -1e9}})
    assert evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=short, as_of=et(short.index[-1], "20:00")) == []


def test_bias_series_becomes_known_on_the_bar_min_bars_closes():
    exact = DAILY.iloc[: bias_module.MIN_BARS]
    spec = make_spec({"op": "gt", "left": {"series": "bias", "part": "summary"}, "right": {"value": -1e9}})
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=exact, as_of=et(exact.index[-1], "20:00"))
    assert len(found) == 1


@pytest.mark.parametrize("part", ["oscillators", "moving_averages", "summary"])
def test_bias_series_matches_bias_bias_at_every_known_bar(part: str):
    """`_bias_series` (the evaluator's growing-window wrapper) must agree with calling
    `bias.bias()` directly at every bar it's known, not just the first -- checked by reading the
    private series straight off, since `evaluate()`'s rising-edge firing would otherwise only
    ever show the FIRST known bar for an always-true condition."""
    field = {"oscillators": "oscillator_score", "moving_averages": "ma_score", "summary": "summary_score"}[part]
    series = _bias_series(DAILY, part)
    assert series.iloc[: bias_module.MIN_BARS - 1].isna().all()
    for n in (bias_module.MIN_BARS, bias_module.MIN_BARS + 7, bias_module.MIN_BARS + 50, len(DAILY)):
        expected = getattr(bias_module.bias(DAILY.iloc[:n]), field)
        assert series.iloc[n - 1] == pytest.approx(expected)


# --- bar_close_5m / bar_close_15m / bar_close_1h cadences --------------------------------------


def set_bin(bars: pd.DataFrame, start: pd.Timestamp, minutes: int, value: float) -> None:
    """Overwrites a whole `minutes`-long run of 1-minute bars, so the resampled bar built from
    them has a known open/high/low/close, not just one bar inside a bin that stays the fixture's
    flat default."""
    bars.loc[start : start + pd.Timedelta(minutes=minutes - 1), ["open", "high", "low", "close"]] = value


def test_bar_close_5m_aggregates_ohlcv_from_the_five_one_minute_bars():
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:30", open=100.0, close=100.0)
    set_bar(bars, DAY, "09:31", high=102.0)
    set_bar(bars, DAY, "09:32", low=98.0)
    set_bar(bars, DAY, "09:34", close=101.0, volume=500.0)
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": -1e9}}, run_on="bar_close_5m")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "09:35"))
    first = next(c for c in found if c.bar_time == et(DAY, "09:30"))
    assert first.evidence["close"] == 101.0


def test_bar_close_5m_a_missing_minute_does_not_let_the_next_bin_be_swallowed():
    # 09:32 is missing entirely (no row, not NaN -- a provider that omits minutes with no trades).
    # Binning by row position (the bug) would count 09:30,09:31,09:33,09:34,09:35 as five rows and
    # put 09:35 in the first bin; binning by phase-aligned timestamp keeps 09:35 in its own bin.
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:30", close=100.0)
    set_bar(bars, DAY, "09:31", close=101.0)
    set_bar(bars, DAY, "09:33", close=103.0)
    set_bar(bars, DAY, "09:34", close=104.0)
    set_bar(bars, DAY, "09:35", close=999.0)  # must never appear in the 09:30 bin
    bars = bars.drop(et(DAY, "09:32"))
    ann = annotate(bars.loc[: et(DAY, "09:39")], "stock")  # only what's closed as of 09:40
    resampled = _resample(ann, "stock", 5, et(DAY, "09:40"))
    first = resampled.loc[et(DAY, "09:30")]
    assert (first["open"], first["close"]) == (100.0, 104.0)  # {09:30, 09:31, 09:33, 09:34}
    assert first["high"] == 104.0  # never 999.0: 09:35 does not leak into this bin
    second = resampled.loc[et(DAY, "09:35")]
    assert second["high"] == 999.0  # 09:35 starts its own bin, not swallowed into the first


def test_bar_close_15m_divides_the_regular_session_into_26_whole_bars():
    bars = minute_bars("stock", DAY)
    bin_starts = pd.date_range(et(DAY, "09:30"), et(DAY, "16:00"), freq="15min", inclusive="left")
    assert len(bin_starts) == 26
    for i, start in enumerate(bin_starts):
        set_bin(bars, start, 15, 101.0 if i % 2 == 0 else 99.0)
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}, run_on="bar_close_15m")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "16:00"))
    assert [c.bar_time for c in found] == list(bin_starts[::2])  # every other bin is a rising edge


def test_bar_close_1h_closes_a_final_partial_bar_when_the_session_ends():
    bars = minute_bars("stock", DAY)
    set_bin(bars, et(DAY, "15:30"), 30, 101.0)  # the whole final 30-minute bin (15:30-15:59) rises
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.5}}, run_on="bar_close_1h")
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "16:00"))
    # 390 regular minutes = 6 full hours (09:30..15:29) plus one final 30-minute bar (15:30..15:59).
    assert [c.bar_time for c in found] == [et(DAY, "15:30")]


def test_bar_close_1h_never_exposes_a_still_forming_bar():
    bars = minute_bars("stock", DAY)
    set_bin(bars, et(DAY, "10:30"), 60, 101.0)  # the whole 10:30-11:29 bin rises
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"value": 100.5}}, run_on="bar_close_1h")
    before_the_hour_closes = evaluate(
        spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "11:29")
    )
    assert before_the_hour_closes == []  # 11:29 hasn't closed yet: the 10:30-11:29 bin isn't done
    after = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "11:30"))
    assert [c.bar_time for c in after] == [et(DAY, "10:30")]


def test_bar_close_1h_never_spans_the_pre_to_regular_boundary():
    bars = minute_bars("stock", DAY)  # pre: 04:00-09:30 (330 min, 5 full hours + a 30-minute tail)
    pre_bins = [et(DAY, "04:00") + pd.Timedelta(hours=h) for h in range(5)] + [et(DAY, "09:00")]
    pre_lengths = [60] * 5 + [30]
    toggled = [*pre_bins, et(DAY, "09:30")]  # regular restarts its own fresh 60-minute bin at 09:30
    for i, (start, minutes) in enumerate(zip(toggled, [*pre_lengths, 60], strict=True)):
        set_bin(bars, start, minutes, 101.0 if i % 2 == 0 else 99.0)
    spec = make_spec(
        {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}, run_on="bar_close_1h", session="extended"
    )
    found = evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=pd.DataFrame(), as_of=et(DAY, "10:30"))
    # only the even bins rise: 04:00, 06:00, 08:00 (pre, hourly) and 09:30 (regular's own fresh bin,
    # not 10:00 -- proof a bin never spans the pre/regular boundary).
    assert [c.bar_time for c in found] == [et(DAY, "04:00"), et(DAY, "06:00"), et(DAY, "08:00"), et(DAY, "09:30")]


def test_check_allows_vwap_on_the_new_intraday_cadences():
    spec = make_spec({"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}, run_on="bar_close_15m")
    assert check(spec) == []
