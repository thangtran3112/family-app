"""Golden tests for the Desk Technical Bias (02f section 3): every vote rule at its boundaries,
the label thresholds at exactly +/-0.1 and +/-0.5, warming up, an unknown value that never votes,
and one end-to-end fixture shaped like the MOCK-SPECS.md NVDA 15m example."""

import math

import numpy as np
import pandas as pd

from ai_trading.core import bias
from ai_trading.core.indicators import Adx, BullBearPower, Ichimoku, Macd, Stochastic, StochRsi


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


def _flat_bars(n: int) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    close = 100 + np.cumsum(rng.normal(0, 0.1, n))
    high = close + np.abs(rng.normal(0.2, 0.05, n))
    low = close - np.abs(rng.normal(0.2, 0.05, n))
    volume = rng.integers(500, 1500, n).astype(float)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume})


# --- label() thresholds, exactly as 02f section 3's table -----------------------------------


def test_label_strong_sell_below_minus_half():
    assert bias.label(-0.500001) == "Strong Sell"


def test_label_sell_includes_minus_half():
    assert bias.label(-0.5) == "Sell"


def test_label_sell_up_to_but_excluding_minus_tenth():
    assert bias.label(-0.100001) == "Sell"


def test_label_neutral_includes_minus_tenth_and_plus_tenth():
    assert bias.label(-0.1) == "Neutral"
    assert bias.label(0.1) == "Neutral"
    assert bias.label(0.0) == "Neutral"


def test_label_buy_above_plus_tenth_and_includes_plus_half():
    assert bias.label(0.100001) == "Buy"
    assert bias.label(0.5) == "Buy"


def test_label_strong_buy_above_plus_half():
    assert bias.label(0.500001) == "Strong Buy"


def test_label_unknown_score_has_no_label():
    assert bias.label(math.nan) is None


# --- RSI / CCI / Williams %R share the "extreme and turning" rule ---------------------------


def test_extreme_turn_vote_buy_below_threshold_and_rising():
    v = bias._extreme_turn_vote(series(25.0, 28.0), buy_below=30, sell_above=70)
    assert v.action == "Buy" and v.values["value"] == 28.0


def test_extreme_turn_vote_sell_above_threshold_and_falling():
    v = bias._extreme_turn_vote(series(75.0, 72.0), buy_below=30, sell_above=70)
    assert v.action == "Sell"


def test_extreme_turn_vote_below_threshold_but_falling_is_neutral():
    v = bias._extreme_turn_vote(series(28.0, 25.0), buy_below=30, sell_above=70)
    assert v.action == "Neutral"


def test_extreme_turn_vote_above_threshold_but_rising_is_neutral():
    v = bias._extreme_turn_vote(series(72.0, 75.0), buy_below=30, sell_above=70)
    assert v.action == "Neutral"


def test_extreme_turn_vote_at_the_threshold_is_neutral():
    assert bias._extreme_turn_vote(series(29.0, 30.0), buy_below=30, sell_above=70).action == "Neutral"
    assert bias._extreme_turn_vote(series(71.0, 70.0), buy_below=30, sell_above=70).action == "Neutral"


def test_extreme_turn_vote_unknown_value_never_votes():
    assert bias._extreme_turn_vote(series(25.0, math.nan), buy_below=30, sell_above=70).action is None
    assert bias._extreme_turn_vote(series(25.0), buy_below=30, sell_above=70).action is None


def test_williams_r_thresholds_are_minus_80_and_minus_20():
    assert bias._extreme_turn_vote(series(-85.0, -81.0), buy_below=-80, sell_above=-20).action == "Buy"
    assert bias._extreme_turn_vote(series(-15.0, -19.0), buy_below=-80, sell_above=-20).action == "Sell"


def test_cci_thresholds_are_minus_100_and_100():
    assert bias._extreme_turn_vote(series(-120.0, -105.0), buy_below=-100, sell_above=100).action == "Buy"
    assert bias._extreme_turn_vote(series(120.0, 105.0), buy_below=-100, sell_above=100).action == "Sell"


# --- Stochastic -------------------------------------------------------------------------------


def test_stochastic_vote_buy_both_below_20_and_k_above_d():
    v = bias._stochastic_vote(Stochastic(series(19.9), series(10.0)))
    assert v.action == "Buy"


def test_stochastic_vote_sell_both_above_80_and_k_below_d():
    v = bias._stochastic_vote(Stochastic(series(85.0), series(90.0)))
    assert v.action == "Sell"


def test_stochastic_vote_at_20_boundary_is_neutral():
    assert bias._stochastic_vote(Stochastic(series(20.0), series(15.0))).action == "Neutral"


def test_stochastic_vote_below_20_but_k_under_d_is_neutral():
    assert bias._stochastic_vote(Stochastic(series(15.0), series(18.0))).action == "Neutral"


def test_stochastic_vote_unknown_value_never_votes():
    assert bias._stochastic_vote(Stochastic(series(math.nan), series(10.0))).action is None


# --- ADX/DMI: Technical Ratings (canonical) -- Buy needs ADX rising, Sell needs ADX FALLING ----


def test_adx_vote_buy_plus_di_above_and_adx_rising_above_20():
    a = Adx(adx=series(19.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Buy"


def test_adx_vote_sell_minus_di_above_and_adx_falling_above_20():
    # Technical Ratings (canonical; see bias.py's module docstring): Sell needs ADX FALLING, the
    # opposite of Buy's rising requirement and of the Screener page's "rising" wording.
    a = Adx(adx=series(25.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(a).action == "Sell"


def test_adx_vote_no_sell_when_adx_is_rising():
    a = Adx(adx=series(19.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_neutral_when_adx_not_above_20():
    a = Adx(adx=series(15.0, 19.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_boundary_adx_exactly_20_is_neutral():
    a = Adx(adx=series(19.0, 20.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"  # ADX must be > 20, not >= 20


def test_adx_vote_boundary_adx_flat_is_neutral_on_both_sides():
    buy_side = Adx(adx=series(21.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(buy_side).action == "Neutral"  # not rising
    sell_side = Adx(adx=series(21.0, 21.0), plus_di=series(10.0, 10.0), minus_di=series(10.0, 30.0))
    assert bias._adx_vote(sell_side).action == "Neutral"  # not falling


def test_adx_vote_neutral_on_the_buy_side_when_adx_is_falling():
    a = Adx(adx=series(25.0, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action == "Neutral"


def test_adx_vote_unknown_value_never_votes():
    a = Adx(adx=series(math.nan, 21.0), plus_di=series(10.0, 30.0), minus_di=series(10.0, 10.0))
    assert bias._adx_vote(a).action is None


# --- Awesome Oscillator: zero-cross or two-bar saucer turn ------------------------------------


def test_ao_vote_buy_on_a_cross_over_zero():
    assert bias._awesome_oscillator_vote(series(1.0, -0.5, 0.2)).action == "Buy"


def test_ao_vote_buy_on_a_saucer_turning_up_above_zero():
    assert bias._awesome_oscillator_vote(series(1.0, 0.5, 0.8)).action == "Buy"


def test_ao_vote_sell_on_a_cross_under_zero():
    assert bias._awesome_oscillator_vote(series(-1.0, 0.5, -0.2)).action == "Sell"


def test_ao_vote_sell_on_a_saucer_turning_down_below_zero():
    assert bias._awesome_oscillator_vote(series(-1.0, -0.5, -0.8)).action == "Sell"


def test_ao_vote_neutral_above_zero_without_crossing_or_turning_up():
    assert bias._awesome_oscillator_vote(series(0.9, 1.0, 0.8)).action == "Neutral"


def test_ao_vote_unknown_value_needs_three_bars():
    assert bias._awesome_oscillator_vote(series(1.0, 0.5)).action is None


# --- Momentum -----------------------------------------------------------------------------


def test_momentum_vote_buy_rising():
    assert bias._momentum_vote(series(1.0, 2.0)).action == "Buy"


def test_momentum_vote_sell_falling():
    assert bias._momentum_vote(series(2.0, 1.0)).action == "Sell"


def test_momentum_vote_neutral_when_equal():
    assert bias._momentum_vote(series(1.0, 1.0)).action == "Neutral"


def test_momentum_vote_unknown_value_never_votes():
    assert bias._momentum_vote(series(1.0)).action is None


# --- MACD ---------------------------------------------------------------------------------


def test_macd_vote_buy_above_signal():
    assert bias._macd_vote(Macd(series(1.0), series(0.5), series(0.5))).action == "Buy"


def test_macd_vote_sell_below_signal():
    assert bias._macd_vote(Macd(series(0.5), series(1.0), series(-0.5))).action == "Sell"


def test_macd_vote_neutral_when_equal():
    assert bias._macd_vote(Macd(series(1.0), series(1.0), series(0.0))).action == "Neutral"


def test_macd_vote_unknown_value_never_votes():
    assert bias._macd_vote(Macd(series(math.nan), series(1.0), series(math.nan))).action is None


# --- Stoch RSI: needs the trend filter too -----------------------------------------------


def test_stoch_rsi_vote_buy_in_a_downtrend():
    sr = StochRsi(series(15.0), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=False, downtrend=True).action == "Buy"


def test_stoch_rsi_vote_sell_in_an_uptrend():
    sr = StochRsi(series(85.0), series(90.0))
    assert bias._stoch_rsi_vote(sr, uptrend=True, downtrend=False).action == "Sell"


def test_stoch_rsi_vote_neutral_without_the_matching_trend():
    sr = StochRsi(series(15.0), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=False, downtrend=False).action == "Neutral"
    sr_high = StochRsi(series(85.0), series(90.0))
    assert bias._stoch_rsi_vote(sr_high, uptrend=False, downtrend=False).action == "Neutral"


def test_stoch_rsi_vote_unknown_value_never_votes():
    sr = StochRsi(series(math.nan), series(10.0))
    assert bias._stoch_rsi_vote(sr, uptrend=True, downtrend=False).action is None


# --- Bull/Bear Power: needs the trend filter too -----------------------------------------


def test_bull_bear_power_vote_buy_in_an_uptrend():
    bb = BullBearPower(bull=series(0.1, 0.2), bear=series(-0.5, -0.3))  # bear < 0 and rising
    assert bias._bull_bear_power_vote(bb, uptrend=True, downtrend=False).action == "Buy"


def test_bull_bear_power_vote_sell_in_a_downtrend():
    bb = BullBearPower(bull=series(0.5, 0.3), bear=series(-0.1, -0.2))  # bull > 0 and falling
    assert bias._bull_bear_power_vote(bb, uptrend=False, downtrend=True).action == "Sell"


def test_bull_bear_power_vote_neutral_without_the_matching_trend():
    bb = BullBearPower(bull=series(0.1, 0.2), bear=series(-0.5, -0.3))
    assert bias._bull_bear_power_vote(bb, uptrend=False, downtrend=False).action == "Neutral"


def test_bull_bear_power_vote_unknown_value_never_votes():
    bb = BullBearPower(bull=series(math.nan, 0.2), bear=series(-0.5, -0.3))
    assert bias._bull_bear_power_vote(bb, uptrend=True, downtrend=False).action is None


# --- Ultimate Oscillator: TradingView's rule literally, >70 Buy and <30 Sell -----------------


def test_ultimate_oscillator_vote_buy_above_70():
    assert bias._ultimate_oscillator_vote(series(75.0)).action == "Buy"


def test_ultimate_oscillator_vote_sell_below_30():
    assert bias._ultimate_oscillator_vote(series(25.0)).action == "Sell"


def test_ultimate_oscillator_vote_boundary_values_are_neutral():
    assert bias._ultimate_oscillator_vote(series(70.0)).action == "Neutral"
    assert bias._ultimate_oscillator_vote(series(30.0)).action == "Neutral"


def test_ultimate_oscillator_vote_unknown_value_never_votes():
    assert bias._ultimate_oscillator_vote(series(math.nan)).action is None


# --- Moving averages: buy when below price, sell when above -----------------------------


def test_ma_vote_buy_below_price():
    assert bias._ma_vote(99.0, 100.0).action == "Buy"


def test_ma_vote_sell_above_price():
    assert bias._ma_vote(101.0, 100.0).action == "Sell"


def test_ma_vote_neutral_when_equal_to_price():
    assert bias._ma_vote(100.0, 100.0).action == "Neutral"


def test_ma_vote_unknown_value_never_votes():
    assert bias._ma_vote(math.nan, 100.0).action is None


# --- Ichimoku -------------------------------------------------------------------------------


def test_ichimoku_vote_buy_when_fully_aligned_up():
    ic = Ichimoku(conversion=series(10.0), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=10.5).action == "Buy"


def test_ichimoku_vote_sell_when_fully_aligned_down():
    ic = Ichimoku(conversion=series(8.0), base=series(8.5), span_a=series(9.0), span_b=series(10.0))
    assert bias._ichimoku_vote(ic, price=7.5).action == "Sell"


def test_ichimoku_vote_neutral_when_not_fully_aligned():
    ic = Ichimoku(conversion=series(10.0), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=9.8).action == "Neutral"  # price has not cleared conversion


def test_ichimoku_vote_unknown_value_never_votes():
    ic = Ichimoku(conversion=series(math.nan), base=series(9.5), span_a=series(9.0), span_b=series(8.0))
    assert bias._ichimoku_vote(ic, price=10.5).action is None


# --- the uptrend/downtrend filter (Decision: price vs its own SMA(50); REPORT-C.md) ----------


def test_trend_above_its_sma_is_an_uptrend():
    up, down = bias._trend(series(10.0, 10.0, 10.0, 20.0), length=3)
    assert up and not down


def test_trend_below_its_sma_is_a_downtrend():
    up, down = bias._trend(series(20.0, 20.0, 20.0, 10.0), length=3)
    assert down and not up


def test_trend_neither_when_unknown():
    up, down = bias._trend(series(10.0, 20.0), length=3)
    assert not up and not down


# --- grouping: counts and the mean score, ignoring unknown votes ----------------------------


def test_score_group_counts_and_means_only_the_known_votes():
    votes = {
        "a": bias.Vote({"value": 1.0}, "Buy"),
        "b": bias.Vote({"value": 2.0}, "Sell"),
        "c": bias.Vote({"value": 3.0}, None),  # unknown: never counted, never scored
        "d": bias.Vote({"value": 4.0}, "Neutral"),
    }
    counts, score = bias._score_group(votes)
    assert counts == bias.VoteCounts(sell=1, neutral=1, buy=1)
    assert score == 0.0


# --- warming up ------------------------------------------------------------------------------


def test_bias_warming_up_below_250_bars():
    assert bias.bias(_flat_bars(bias.MIN_BARS - 1)) == "warming up"


def test_bias_not_warming_up_at_exactly_250_bars():
    assert bias.bias(_flat_bars(bias.MIN_BARS)) != "warming up"


# --- an unknown indicator value never votes, end to end --------------------------------------


def _nvda_shape_bars() -> pd.DataFrame:
    """260 synthetic 15m bars: a rally to a local high, a pullback, a recovery, and a small
    topping dip in the final few bars -- built (by an offline parameter search over this
    generator, see REPORT-C.md) to land on MOCK-SPECS.md's NVDA 15m shape: Oscillators Sell
    1/Neutral 7/Buy 3, MAs Sell 2/Neutral 1/Buy 12, summary +0.42 Buy. Not NVDA's own prices --
    hand-matching 26 real TradingView rule outcomes from a vendor's live values isn't reproducible
    offline, so this fixture's shape, not its literal numbers, is the golden value, pinned here."""
    n = 260
    rng = np.random.default_rng(45)
    t = np.arange(n)
    base = 180 + 10 * (1 / (1 + np.exp(-(t - 90) / 25)))
    pullback = np.where(t > 150, -3.0 * (1 - np.exp(-(t - 150) / 40)), 0.0)
    recover = np.where(t > 230, 2.0 * (1 - np.exp(-(t - 230) / 15)), 0.0)
    close = base + pullback + recover + rng.normal(0, 0.15, n)
    close[-6:] -= np.linspace(0, 0.58, 6)
    high = close + np.abs(rng.normal(0.25, 0.08, n))
    low = close - np.abs(rng.normal(0.25, 0.08, n))
    volume = rng.integers(500, 2000, n).astype(float)
    return pd.DataFrame({"high": high, "low": low, "close": close, "volume": volume})


def test_bias_end_to_end_matches_the_nvda_mock_shape():
    result = bias.bias(_nvda_shape_bars())
    assert result != "warming up"
    counts = result.oscillator_counts
    assert (counts.sell, counts.neutral, counts.buy) == (1, 7, 3)
    ma_counts = result.ma_counts
    assert (ma_counts.sell, ma_counts.neutral, ma_counts.buy) == (2, 1, 12)
    assert round(result.summary_score, 2) == 0.42
    assert result.summary_label == "Buy"
    assert result.volatility_label is not None  # 260 bars is well past ATR's 113-bar warm-up


def test_bias_excludes_an_unknown_indicator_from_its_group_count():
    # VWMA's own 0/0 -> NaN convention (indicators.vwma): zero volume makes it unknown, so it
    # never votes and drops out of the 15 moving-average votes.
    bars = _nvda_shape_bars()
    bars["volume"] = 0.0
    result = bias.bias(bars)
    assert result != "warming up"
    assert result.moving_averages["vwma_20"].action is None
    assert result.ma_counts.sell + result.ma_counts.neutral + result.ma_counts.buy == 14
