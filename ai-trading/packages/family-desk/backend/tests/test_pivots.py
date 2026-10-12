from datetime import date

import numpy as np
import pandas as pd
import pytest
from bars import daily_bars, trading_days

from ai_trading.core import pivots

# A single fixed prior period (checked by hand and cross-checked offline against finta's PIVOT
# and pandas_ta's pivot_fibonacci/pivot_camarilla; see the report for the largest difference).
HIGH, LOW, CLOSE = 110.0, 100.0, 105.0


def test_classic_pivots():
    out = pivots.classic_pivots(HIGH, LOW, CLOSE)
    assert out == {"P": 105.0, "R1": 110.0, "S1": 100.0, "R2": 115.0, "S2": 95.0, "R3": 120.0, "S3": 90.0}


def test_fibonacci_pivots():
    out = pivots.fibonacci_pivots(HIGH, LOW, CLOSE)
    assert out == {
        "P": 105.0,
        "R1": pytest.approx(108.82),
        "S1": pytest.approx(101.18),
        "R2": pytest.approx(111.18),
        "S2": pytest.approx(98.82),
        "R3": 115.0,
        "S3": 95.0,
    }


def test_camarilla_pivots():
    out = pivots.camarilla_pivots(HIGH, LOW, CLOSE)
    assert out["P"] == 105.0
    np.testing.assert_allclose(out["R1"], 105.0 + 10 * 1.1 / 12)
    np.testing.assert_allclose(out["S1"], 105.0 - 10 * 1.1 / 12)
    np.testing.assert_allclose(out["R2"], 105.0 + 10 * 1.1 / 6)
    np.testing.assert_allclose(out["S2"], 105.0 - 10 * 1.1 / 6)
    np.testing.assert_allclose(out["R3"], 107.75)
    np.testing.assert_allclose(out["S3"], 102.25)


def test_pivots_vectorize_over_a_series():
    high = pd.Series([HIGH, HIGH + 10])
    low = pd.Series([LOW, LOW])
    close = pd.Series([CLOSE, CLOSE])
    out = pivots.classic_pivots(high, low, close)
    assert isinstance(out["P"], pd.Series)
    np.testing.assert_allclose(out["P"], [105.0, 108.333333], rtol=1e-6)


def test_prior_session_is_the_prior_trading_day():
    daily = daily_bars([date(2026, 11, 24), date(2026, 11, 25)], [101.0, 102.0])
    days = pd.Index([date(2026, 11, 27)])  # Thanksgiving Thursday skipped
    high, low, close = pivots.prior_period_hlc(daily, days, "stock", "session")
    assert high.iloc[0] == low.iloc[0] == close.iloc[0] == 102.0


def test_prior_week_spans_the_calendar_week_before():
    days = trading_days("stock", date(2026, 10, 30), 15)  # Oct 12 .. Oct 30, 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([date(2026, 11, 2)]), "stock", "week")
    # the prior week (Mon Oct 26 .. Fri Oct 30) has closes 11..15
    assert (high.iloc[0], low.iloc[0], close.iloc[0]) == (15.0, 11.0, 15.0)


def test_prior_month_spans_the_calendar_month_before():
    days = trading_days("stock", date(2026, 10, 30), 15)  # all of October 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([date(2026, 11, 2)]), "stock", "month")
    assert (high.iloc[0], low.iloc[0], close.iloc[0]) == (15.0, 1.0, 15.0)


def test_prior_week_is_nan_without_a_bar_in_that_week():
    daily = daily_bars([date(2026, 10, 6)], [100.0])  # one lone Tuesday bar
    high, _, _ = pivots.prior_period_hlc(daily, pd.Index([date(2026, 10, 6)]), "stock", "week")
    assert np.isnan(high.iloc[0])
