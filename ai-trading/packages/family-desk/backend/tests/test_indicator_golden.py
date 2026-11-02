"""Golden tests: the Desk's indicators pinned against values that do not come from the code under test.

Three kinds of reference, all independent of `ai_trading.core.indicators`:
- closed forms derived by hand (a ramp's EMA and MACD, a 14-bar RSI, a three-bar VWAP);
- TA-Lib 0.8.3 on the classic 33-close Wilder RSI series, and at the last bar of 300 REAL daily TSLA bars (Alpaca SIP);
- plain-Python loops over REAL one-minute TSLA bars (Alpaca SIP) around the 2026-09-24 close and 2026-09-25 open.
The real-bar numbers live in `contracts/fixtures/indicator-golden-v1/golden.json`, which the frontend pins its own
indicators to as well (`lib/indicators.golden.test.ts`). Regenerate it with `tests/make_indicator_golden.py`.

Conventions the Desk uses (and these tests pin): Wilder smoothing seeded by the mean of the first `length` values
(RSI, ATR); EMA seeded with the FIRST value and unknown until `length` bars (so it differs from TA-Lib's SMA-seeded
EMA by a transient that has decayed to nothing after a few hundred bars); VWAP of the typical price
(high + low + close) / 3 over the regular session only, restarting each New York trading day.
"""

from datetime import date

import numpy as np
import pandas as pd
import pytest
from bars import minute_bars, set_bar, trading_days
from indicator_golden import GOLDEN, golden_daily, golden_minutes

from ai_trading.core import indicators
from ai_trading.core.calendar import annotate, et


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


# ---- RSI ----------------------------------------------------------------------------------------------------------

# The classic 14-period RSI worked example (Wilder / StockCharts): 33 closes give 19 RSI values.
WILDER_CLOSES = [
    *(44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89),
    *(46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25),
    *(45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13),
]
# TA-Lib 0.8.3 `RSI(close, 14)` on exactly these closes, bars 14..32, rounded to the cent.
WILDER_RSI = [
    *(70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34),
    *(54.67, 50.39, 40.02, 41.49, 41.90, 45.50, 37.32, 33.09, 37.79),
]


def test_rsi_14_matches_the_wilder_worked_example():
    got = indicators.rsi(series(*WILDER_CLOSES), 14)
    assert got.iloc[:14].isna().all()  # a delta needs two closes, and 14 deltas seed the averages: bar 14 is first
    np.testing.assert_allclose(got.iloc[14:].to_numpy(), WILDER_RSI, atol=0.005)


def test_rsi_is_wilders_smoothing_not_a_simple_moving_average():
    # 15 closes alternating +1/-1 (seven ups, seven downs): average gain = average loss = 0.5, so RSI = 50.
    closes = [10.0 + (i % 2) for i in range(15)]
    assert indicators.rsi(series(*closes), 14).iloc[14] == pytest.approx(50.0)
    # A +2 bar. Wilder: gain = (0.5 * 13 + 2) / 14 = 8.5 / 14, loss = (0.5 * 13) / 14 = 6.5 / 14, RSI = 100 * 8.5 / 15.
    # A simple 14-bar average would drop the oldest +1 instead: gains 8, losses 7, RSI = 100 * 8 / 15 = 53.33.
    closes.append(12.0)
    assert indicators.rsi(series(*closes), 14).iloc[15] == pytest.approx(100 * 8.5 / 15)
    # Then a -1 bar: gain = 8.5 * 13 / 196, loss = (6.5 * 13 + 14) / 196, RSI = 100 * 110.5 / 209.
    closes.append(11.0)
    assert indicators.rsi(series(*closes), 14).iloc[16] == pytest.approx(100 * 110.5 / 209)


def test_rsi_extremes_a_flat_run_and_too_few_bars():
    assert indicators.rsi(series(*range(1, 30)), 14).iloc[-1] == 100  # no losses
    assert indicators.rsi(series(*range(30, 1, -1)), 14).iloc[-1] == 0  # no gains
    assert indicators.rsi(series(*[5.0] * 30), 14).iloc[-1] == 50  # nothing moved: neither side
    assert indicators.rsi(series(*range(1, 15)), 14).isna().all()  # 14 closes make 13 deltas: one short of the seed


# ---- EMA and MACD -------------------------------------------------------------------------------------------------


def test_ema_is_seeded_with_the_first_value_and_unknown_until_length_bars():
    # Two bars, span 2 (alpha 2/3): seeded with 10 -> 2/3 * 20 + 1/3 * 10 = 16.667. An SMA seed would read 15.
    out = indicators.ema(series(10, 20), 2)
    assert np.isnan(out.iloc[0])
    assert out.iloc[1] == pytest.approx(50 / 3)


def test_ema_of_a_ramp_follows_its_closed_form():
    # x_t = t, alpha = 2 / (n + 1), seed x_0 = 0  =>  EMA_t = t - ((1 - alpha) / alpha) * (1 - (1 - alpha) ** t).
    for length in (9, 21):
        alpha = 2 / (length + 1)
        t = np.arange(120)
        expected = t - (1 - alpha) / alpha * (1 - (1 - alpha) ** t)
        got = indicators.ema(series(*t), length).to_numpy()
        assert np.isnan(got[: length - 1]).all()
        np.testing.assert_allclose(got[length - 1 :], expected[length - 1 :], rtol=1e-12)
    # The lag settles at (1 - alpha) / alpha = (n - 1) / 2 bars: 4 for an EMA 9, 10 for an EMA 21.
    assert indicators.ema(series(*range(400)), 9).iloc[-1] == pytest.approx(399 - 4)
    assert indicators.ema(series(*range(400)), 21).iloc[-1] == pytest.approx(399 - 10)


def test_macd_of_a_ramp_follows_its_closed_form():
    # With EMA_t = t - lag * (1 - r ** t) for each span (lag 5.5, r 11/13 for span 12; lag 12.5, r 25/27 for span 26):
    # line_t = 12.5 * (1 - (25/27) ** t) - 5.5 * (1 - (11/13) ** t), which settles at 12.5 - 5.5 = 7.
    t = np.arange(400)
    expected_line = 12.5 * (1 - (25 / 27) ** t) - 5.5 * (1 - (11 / 13) ** t)
    m = indicators.macd(series(*t))
    assert m.line.iloc[:25].isna().all() and m.line.notna().iloc[25:].all()  # unknown until `slow` (26) bars
    np.testing.assert_allclose(m.line.to_numpy()[25:], expected_line[25:], rtol=1e-12)
    assert m.signal.iloc[:33].isna().all() and m.signal.notna().iloc[33:].all()  # slow + signal - 1 = 34 bars
    assert m.histogram.iloc[:33].isna().all()
    np.testing.assert_allclose(m.histogram.to_numpy()[33:], (m.line - m.signal).to_numpy()[33:], rtol=0, atol=0)
    assert m.line.iloc[-1] == pytest.approx(7.0, abs=1e-9)
    assert m.signal.iloc[-1] == pytest.approx(7.0, abs=1e-9)
    assert m.histogram.iloc[-1] == pytest.approx(0.0, abs=1e-9)


def test_macd_signal_is_the_ema_9_of_the_macd_line():
    # The signal is seeded with the first MACD value (bar 25) and unknown until nine MACD values exist (bar 33).
    close = series(*(100 + 10 * np.sin(np.arange(80) / 5)))
    m = indicators.macd(close)
    alpha, line, expected = 2 / 10, m.line.dropna().to_numpy(), []
    for i, value in enumerate(line):
        expected.append(value if i == 0 else alpha * value + (1 - alpha) * expected[-1])
    np.testing.assert_allclose(m.signal.dropna().to_numpy(), expected[8:], rtol=1e-12)
    assert m.signal.first_valid_index() == 33


# ---- ATR ----------------------------------------------------------------------------------------------------------


def test_atr_is_wilders_average_of_the_true_range():
    # True ranges 1, 2.5, 1, 4.5 (a gap from the prior close at bars 1 and 3). Length 3: seed = (1 + 2.5 + 1) / 3 = 1.5,
    # then (1.5 * 2 + 4.5) / 3 = 2.5. A simple average of the last three true ranges would read 8/3.
    bars = pd.DataFrame(
        {"high": [10.0, 12.0, 12.0, 16.0], "low": [9.0, 11.0, 11.0, 12.0], "close": [9.5, 11.5, 11.5, 15]}
    )
    out = indicators.atr(bars, 3)
    assert out.iloc[:2].isna().all()
    assert out.iloc[2] == pytest.approx(1.5)
    assert out.iloc[3] == pytest.approx(2.5)


# ---- Real bars: TA-Lib at the last of 300 daily TSLA bars, and the early bars from independent loops ----------------


@pytest.mark.parametrize(
    ("name", "compute", "tolerance"),
    [
        ("sma_5", lambda f: indicators.sma(f["close"], 5), 1e-9),
        ("sma_20", lambda f: indicators.sma(f["close"], 20), 1e-9),
        ("sma_50", lambda f: indicators.sma(f["close"], 50), 1e-9),
        ("sma_100", lambda f: indicators.sma(f["close"], 100), 1e-9),
        ("sma_200", lambda f: indicators.sma(f["close"], 200), 1e-9),
        # An EMA of 20 or fewer has converged by bar 300 and agrees with TA-Lib's SMA-seeded one; 50+ has not.
        ("ema_5", lambda f: indicators.ema(f["close"], 5), 1e-6),
        ("ema_9", lambda f: indicators.ema(f["close"], 9), 1e-6),
        ("ema_10", lambda f: indicators.ema(f["close"], 10), 1e-6),
        ("ema_20", lambda f: indicators.ema(f["close"], 20), 1e-6),
        ("ema_21", lambda f: indicators.ema(f["close"], 21), 1e-6),
        ("rsi_14", lambda f: indicators.rsi(f["close"], 14), 1e-6),
        ("atr_14", lambda f: indicators.atr(f, 14), 1e-6),
        ("macd_line", lambda f: indicators.macd(f["close"]).line, 1e-6),
        ("macd_signal", lambda f: indicators.macd(f["close"]).signal, 1e-6),
        ("macd_histogram", lambda f: indicators.macd(f["close"]).histogram, 1e-6),
        # The bias gauge's other oscillators.
        ("stoch_k", lambda f: indicators.stochastic(f).k, 1e-6),
        ("stoch_d", lambda f: indicators.stochastic(f).d, 1e-6),
        ("cci_20", lambda f: indicators.cci(f, 20), 1e-6),
        ("williams_r_14", lambda f: indicators.williams_r(f, 14), 1e-6),
        ("momentum_10", lambda f: indicators.momentum(f["close"], 10), 1e-6),
        ("adx_14", lambda f: indicators.adx(f, 14).adx, 1e-6),
        ("plus_di_14", lambda f: indicators.adx(f, 14).plus_di, 1e-6),
        ("minus_di_14", lambda f: indicators.adx(f, 14).minus_di, 1e-6),
        ("ultimate_oscillator", lambda f: indicators.ultimate_oscillator(f), 1e-6),
        ("bull_power_13", lambda f: indicators.bull_bear_power(f, 13).bull, 1e-6),
        ("bear_power_13", lambda f: indicators.bull_bear_power(f, 13).bear, 1e-6),
    ],
)
def test_real_tsla_daily_indicators_match_ta_lib_at_the_last_bar(name, compute, tolerance):
    assert float(compute(golden_daily()).iloc[-1]) == pytest.approx(GOLDEN["daily_last"][name], abs=tolerance)


@pytest.mark.parametrize("name", ["ema_9", "ema_21", "rsi_14", "atr_14", "macd_line", "macd_signal", "macd_histogram"])
def test_real_tsla_daily_early_bars_match_the_independent_loops(name):
    frame = golden_daily()
    computed = {
        "ema_9": indicators.ema(frame["close"], 9),
        "ema_21": indicators.ema(frame["close"], 21),
        "rsi_14": indicators.rsi(frame["close"], 14),
        "atr_14": indicators.atr(frame, 14),
        "macd_line": indicators.macd(frame["close"]).line,
        "macd_signal": indicators.macd(frame["close"]).signal,
        "macd_histogram": indicators.macd(frame["close"]).histogram,
    }[name]
    pinned = GOLDEN["daily_warmup"][name]
    assert len(pinned) == 3
    for index, value in pinned:
        assert computed.iloc[index] == pytest.approx(value, abs=1e-9), (name, index)
    assert computed.iloc[: pinned[0][0]].isna().all()  # nothing before the first pinned bar is known


def test_a_first_value_seed_is_not_a_bug_it_is_a_transient():
    # On real bars the first-value EMA 21 starts $3 from TA-Lib's SMA-seeded one (bar 20); by bar 300 they agree.
    frame = golden_daily()
    assert indicators.ema(frame["close"], 21).iloc[20] == pytest.approx(GOLDEN["daily_warmup"]["ema_21"][0][1])
    assert abs(float(indicators.ema(frame["close"], 21).iloc[-1]) - GOLDEN["daily_last"]["ema_21"]) < 1e-9


# ---- VWAP ---------------------------------------------------------------------------------------------------------


def two_days() -> tuple[pd.DataFrame, list[date]]:
    days = trading_days("stock", date(2026, 10, 6), 2)
    return pd.concat([minute_bars("stock", day) for day in days]), days


def test_vwap_weights_the_typical_price_not_the_close():
    bars, days = two_days()
    # typical = (108 + 96 + 99) / 3 = 101 (the close is 99); then (106 + 100 + 103) / 3 = 103 on three times the volume.
    set_bar(bars, days[1], "09:30", high=108.0, low=96.0, close=99.0, volume=1000.0)
    set_bar(bars, days[1], "09:31", high=106.0, low=100.0, close=103.0, volume=3000.0)
    vwap = indicators.session_vwap(annotate(bars, "stock"))
    assert vwap.loc[et(days[1], "09:30")] == pytest.approx(101.0)
    assert vwap.loc[et(days[1], "09:31")] == pytest.approx((101 * 1000 + 103 * 3000) / 4000)


def test_vwap_restarts_each_trading_day_and_skips_extended_hours():
    bars, days = two_days()
    set_bar(bars, days[0], "15:59", high=300.0, low=300.0, close=300.0, volume=9_000_000.0)  # yesterday's last bar
    set_bar(bars, days[1], "04:00", high=500.0, low=500.0, close=500.0, volume=9_000_000.0)  # today, pre-market
    set_bar(bars, days[1], "09:30", high=200.0, low=200.0, close=200.0, volume=500.0)
    set_bar(bars, days[1], "16:00", high=700.0, low=700.0, close=700.0, volume=9_000_000.0)  # today, after-hours
    vwap = indicators.session_vwap(annotate(bars, "stock"))
    assert np.isnan(vwap.loc[et(days[1], "04:00")])  # no VWAP before the open
    assert vwap.loc[et(days[1], "09:30")] == 200.0  # neither yesterday's volume nor the pre-market volume is in it
    assert np.isnan(vwap.loc[et(days[1], "16:00")])  # none after the close
    assert vwap.loc[et(days[1], "15:59")] < 101.0  # the after-hours print (700) is in no regular value
    assert vwap.loc[et(days[0], "15:59")] > 100.0  # yesterday keeps its own session sum


def test_vwap_is_unknown_until_the_first_traded_minute():
    bars, days = two_days()
    set_bar(bars, days[1], "09:30", high=105.0, low=99.0, close=102.0, volume=0.0)
    set_bar(bars, days[1], "09:31", high=108.0, low=96.0, close=99.0, volume=100.0)
    vwap = indicators.session_vwap(annotate(bars, "stock"))
    assert np.isnan(vwap.loc[et(days[1], "09:30")])
    assert vwap.loc[et(days[1], "09:31")] == pytest.approx(101.0)


def test_real_tsla_minute_vwap_matches_the_independent_loop():
    # 150 real one-minute bars: the last 20 regular and the first 20 after-hours minutes of 2026-09-24, then 20
    # pre-market and 90 regular minutes of 2026-09-25. Expected values are plain-Python sums per New York day.
    got = indicators.session_vwap(annotate(golden_minutes(), "stock"))
    expected = GOLDEN["vwap"]
    assert len(got) == len(expected) == 150
    phases = [row[5] for row in GOLDEN["minutes"]["rows"]]
    assert phases.count("regular") == 110 and phases.count("pre") == 20 and phases.count("post") == 20
    for value, want, phase in zip(got, expected, phases, strict=True):
        if phase == "regular":
            assert value == pytest.approx(want, rel=1e-12)
        else:
            assert np.isnan(value) and want is None
    # The restart: the first regular bar of 09-25 is its own typical price, not a blend with 09-24.
    first = next(row for row in GOLDEN["minutes"]["rows"] if row[0].startswith("2026-09-25T13:30"))
    assert got.loc[pd.Timestamp(first[0])] == pytest.approx((first[1] + first[2] + first[3]) / 3)
