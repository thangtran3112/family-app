"""`engine.cardback.compute_card_back` (PROTO-BRIEF.md section 4 L2; 02f section 3): pure, no I/O.

`bias_label`/`bias_score` are the Desk Technical Bias's "summary" score -- 02f section 3's one
bias gauge on a watchlist card back (the Technicals page's separate oscillator/moving-average
gauges are a Phase 4 UI concern, out of scope here)."""

from datetime import date

import numpy as np
import pandas as pd
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.core import indicators, pivots
from ai_trading.core.bias import MIN_BARS
from ai_trading.engine.cardback import compute_card_back

DAY = date(2026, 10, 6)


def _random_walk_bars(n: int, *, seed: int = 1) -> pd.DataFrame:
    """`n` bars ending within `DAY`'s own extended session, so `annotate()` (used by the pivot
    calculation every `compute_card_back` call makes, regardless of timeframe) has a real,
    tz-aware index to work with -- not just the bare `RangeIndex` `tests/test_bias.py`'s own
    fixtures use, since `bias.bias()` alone never looks at the index but `cardback` also computes
    pivots from it."""
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 0.1, n))
    high = close + np.abs(rng.normal(0.2, 0.05, n))
    low = close - np.abs(rng.normal(0.2, 0.05, n))
    volume = rng.integers(500, 1500, n).astype(float)
    index = pd.date_range(end=minute_bars("stock", DAY).index[-1], periods=n, freq="1min")
    return pd.DataFrame({"open": close, "high": high, "low": low, "close": close, "volume": volume}, index=index)


# --- warming up / known bias (02f section 3's 250-bar threshold) --------------------------------


def test_warming_up_below_250_bars_has_no_bias():
    card = compute_card_back("AAPL", "1h", _random_walk_bars(MIN_BARS - 1), "stock")

    assert card.bias_label is None
    assert card.bias_score is None
    assert card.oscillators == {}
    assert card.moving_averages == {}
    assert card.atr_pct_label in ("low", "normal", "high")  # 249 bars is past ATR's 113-bar warm-up


def test_warming_up_with_too_few_bars_for_atr_defaults_to_normal():
    card = compute_card_back("AAPL", "1h", _random_walk_bars(10), "stock")

    assert card.bias_label is None
    assert card.atr_pct_label == "normal"


def test_bias_is_known_at_exactly_250_bars():
    bars = _random_walk_bars(MIN_BARS)
    card = compute_card_back("AAPL", "1h", bars, "stock")

    assert card.bias_label is not None
    assert card.bias_score is not None
    assert card.oscillators
    assert card.moving_averages
    assert all(value in (-1.0, 0.0, 1.0) for value in card.oscillators.values())
    assert all(value in (-1.0, 0.0, 1.0) for value in card.moving_averages.values())


def test_atr_pct_label_matches_indicators_atr_percent_directly():
    bars = _random_walk_bars(MIN_BARS)
    card = compute_card_back("AAPL", "1h", bars, "stock")

    expected = indicators.atr_percent(bars, 14, 100).label.iloc[-1]
    assert card.atr_pct_label == expected


def test_oscillators_and_moving_averages_omit_an_unknown_vote():
    bars = _random_walk_bars(MIN_BARS)
    bars["volume"] = 0.0  # VWMA's own 0/0 -> NaN convention (indicators.vwma): never votes
    card = compute_card_back("AAPL", "1h", bars, "stock")

    assert "vwma_20" not in card.moving_averages


# --- pivots: prior session (intraday), prior week (1D), prior month (1W) ------------------------


def test_pivots_for_an_intraday_timeframe_use_the_prior_regular_session():
    prior, today = trading_days("stock", DAY, 2)
    bars = pd.concat([minute_bars("stock", prior, price=100.0), minute_bars("stock", today, price=110.0)])
    set_bar(bars, prior, "10:00", high=105.0, low=95.0, close=102.0)
    card = compute_card_back("AAPL", "15m", bars, "stock")

    # The regular session's last bar (15:59) is untouched, so the prior day's close is the
    # baseline 100.0, not the 10:00 bar's own 102.0.
    assert card.pivots == pivots.classic_pivots(105.0, 95.0, 100.0)


def test_pivots_for_1d_use_the_prior_week():
    days = trading_days("stock", date(2026, 10, 30), 15)  # Oct 12 .. Oct 30, 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    card = compute_card_back("AAPL", "1D", daily, "stock")

    # The prior week (Mon Oct 26 .. Fri Oct 30) has closes 11..15 (matches test_pivots.py).
    assert card.pivots == pivots.classic_pivots(15.0, 11.0, 15.0)


def test_pivots_for_1w_use_the_prior_month():
    weeks = [date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 21), date(2026, 9, 28), date(2026, 10, 5)]
    weekly = daily_bars(weeks, [10.0, 12.0, 8.0, 14.0, 20.0])
    card = compute_card_back("AAPL", "1W", weekly, "stock")

    # September's four weekly rows (closes 10, 12, 8, 14): high 14, low 8, last-in-month close 14.
    assert card.pivots == pivots.classic_pivots(14.0, 8.0, 14.0)


def test_pivots_are_empty_without_a_prior_completed_period():
    card = compute_card_back("AAPL", "1D", daily_bars([DAY], [100.0]), "stock")

    assert card.pivots == {}


def test_pivots_are_empty_with_no_bars_at_all():
    card = compute_card_back("AAPL", "1D", daily_bars([], []), "stock")

    assert card.pivots == {}


# --- identity ------------------------------------------------------------------------------------


def test_card_back_carries_its_own_symbol_and_timeframe():
    card = compute_card_back("MSFT", "5m", _random_walk_bars(10), "stock")

    assert card.symbol == "MSFT"
    assert card.timeframe == "5m"
