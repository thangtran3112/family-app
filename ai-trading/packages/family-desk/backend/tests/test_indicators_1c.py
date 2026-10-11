"""Golden-value tests for the Phase 1c indicator set (02f section 3). Values are checked by hand
(see each test's comment) and cross-checked offline against the `ta` library on a larger synthetic
fixture outside this repo (see REPORT-A.md); `ta`'s own warm-up and seeding conventions differ in
places noted below, so this file's golden values are this module's own arithmetic, not `ta`'s."""

import numpy as np
import pandas as pd

from ai_trading.core import indicators


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


def ohlc(high: list[float], low: list[float], close: list[float], volume: list[float] | None = None) -> pd.DataFrame:
    volume = volume if volume is not None else [1.0] * len(high)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume}, dtype=float)


def test_macd_line_signal_and_histogram():
    # fast=2 (alpha 2/3), slow=4 (alpha 2/5), signal=2, by hand via the existing ema() recursion
    close = series(1, 2, 3, 4, 5, 6, 7, 8)
    m = indicators.macd(close, fast=2, slow=4, signal=2)
    np.testing.assert_allclose(m.line.to_numpy()[3:], [0.694519, 0.811773, 0.885418, 0.930702, 0.958238], atol=1e-6)
    assert m.line.iloc[:3].isna().all()  # NaN until `slow` (4) bars
    np.testing.assert_allclose(m.signal.to_numpy()[4:], [0.772688, 0.847841, 0.903082, 0.939853], atol=1e-6)
    assert m.signal.iloc[:4].isna().all()  # NaN until slow + signal - 1 = 5 bars
    np.testing.assert_allclose(m.histogram.to_numpy()[4:], [0.039085, 0.037577, 0.02762, 0.018386], atol=1e-6)


def test_stochastic_slow_k_and_d():
    # length=3, smooth_k=2, smooth_d=2. Raw %K by hand: 100*(close-lowestLow3)/(highestHigh3-lowestLow3)
    # = [40, 80, 60, 80] at bars 2-5; slow %K is its 2-bar SMA, %D the 2-bar SMA of that.
    bars = ohlc([12, 13, 11, 14, 13, 15], [8, 9, 9, 10, 10, 11], [10, 12, 10, 13, 12, 14])
    st = indicators.stochastic(bars, length=3, smooth_k=2, smooth_d=2)
    np.testing.assert_allclose(st.k.to_numpy()[3:], [60.0, 70.0, 70.0])
    assert st.k.iloc[:3].isna().all()  # NaN until length + smooth_k - 1 = 4 bars
    np.testing.assert_allclose(st.d.to_numpy()[4:], [65.0, 70.0])
    assert st.d.iloc[:4].isna().all()  # NaN until length + smooth_k + smooth_d - 2 = 5 bars


def test_stochastic_flat_range_is_50():
    bars = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    st = indicators.stochastic(bars, length=2, smooth_k=1, smooth_d=1)
    assert st.k.iloc[-1] == 50.0 and st.d.iloc[-1] == 50.0


def test_stoch_rsi_k_and_d():
    # rsi_length=3, stoch_length=3, smooth_k=2, smooth_d=2. RSI (Wilder, length 3) on this close
    # series is [75, 54.545455, 75, 56.074766, 75] at bars 3-7 by hand; stochastic-of-RSI and its
    # double smoothing give the values below (matches the module's RSI arithmetic exactly).
    close = series(10, 11, 10, 12, 11, 13, 12, 14)
    sr = indicators.stoch_rsi(close, smooth_k=2, smooth_d=2, rsi_length=3, stoch_length=3)
    np.testing.assert_allclose(sr.k.to_numpy()[6:], [53.738318, 53.738318], atol=1e-5)
    assert sr.k.iloc[:6].isna().all()  # NaN until rsi_length + stoch_length + smooth_k - 2 = 6 bars
    np.testing.assert_allclose(sr.d.to_numpy()[7:], [53.738318], atol=1e-5)
    assert sr.d.iloc[:7].isna().all()  # NaN until +smooth_d - 1 more = 8 bars (the dataclass's minimum)


def test_cci_values_and_flat_window_is_zero():
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.cci(bars, length=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [-50.0, 90.909091], atol=1e-5)
    assert out.iloc[:2].isna().all()  # NaN until `length` (3) bars
    flat = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    assert indicators.cci(flat, length=3).iloc[-1] == 0.0


def test_adx_wilder_seeding_on_a_clean_uptrend():
    # length=2, a steady uptrend so -DM is always 0 and ADX should read 100 once it warms up.
    bars = ohlc([10, 12, 15, 19, 24], [9, 10, 12, 15, 19], [9.5, 11, 14, 18, 23])
    a = indicators.adx(bars, length=2)
    np.testing.assert_allclose(a.plus_di.to_numpy()[1:], [57.142857, 69.565217, 76.190476, 80.503145], atol=1e-5)
    assert (a.minus_di.to_numpy()[1:] == 0.0).all()
    assert a.plus_di.iloc[:1].isna().all()  # NaN until `length` (2) bars
    np.testing.assert_allclose(a.adx.to_numpy()[2:], [100.0, 100.0, 100.0])
    assert a.adx.iloc[:2].isna().all()  # NaN until 2*length - 1 = 3 bars


def test_awesome_oscillator():
    # fast=2, slow=3: SMA2 - SMA3 of the median price.
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.awesome_oscillator(bars, fast=2, slow=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [0.166667, 0.0], atol=1e-5)
    assert out.iloc[:2].isna().all()  # NaN until `slow` (3) bars


def test_momentum():
    out = indicators.momentum(series(10, 12, 9, 14, 11), length=2)
    np.testing.assert_allclose(out.to_numpy()[2:], [-1.0, 2.0, 2.0])
    assert out.iloc[:2].isna().all()  # NaN until length + 1 = 3 bars


def test_williams_r_and_flat_range():
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.williams_r(bars, length=3)
    np.testing.assert_allclose(out.to_numpy()[2:], [-60.0, -20.0])
    assert out.iloc[:2].isna().all()  # NaN until `length` (3) bars
    flat = ohlc([10, 10, 10], [10, 10, 10], [10, 10, 10])
    assert indicators.williams_r(flat, length=3).iloc[-1] == -50.0


def test_bull_bear_power():
    # length=2 (EMA alpha 2/3) by hand via the existing ema() recursion.
    bars = ohlc([12, 13, 11, 14], [8, 9, 9, 10], [10, 12, 10, 13])
    out = indicators.bull_bear_power(bars, length=2)
    np.testing.assert_allclose(out.bull.to_numpy()[1:], [1.666667, 0.555556, 1.851852], atol=1e-5)
    np.testing.assert_allclose(out.bear.to_numpy()[1:], [-2.333333, -1.444444, -2.148148], atol=1e-5)
    assert out.bull.iloc[:1].isna().all()  # NaN until `length` (2) bars


def test_ultimate_oscillator():
    bars = ohlc([12, 13, 11, 14, 15], [8, 9, 9, 10, 11], [10, 12, 10, 13, 14])
    out = indicators.ultimate_oscillator(bars, fast=2, mid=3, slow=4)
    np.testing.assert_allclose(out.to_numpy()[3:], [59.406308, 70.562771], atol=1e-5)
    assert out.iloc[:3].isna().all()  # NaN until `slow` (4) bars
