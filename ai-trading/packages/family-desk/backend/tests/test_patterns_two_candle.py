"""Two-candle patterns: clear setups, near-misses, bearish twins, trend rule and occurrences."""

import pandas as pd
import pytest

from ai_trading.core import patterns

# A bearish pattern is its bullish twin with every bar flipped around 100: open and close swap sides of the
# range, so the twin has the same margins and the same thresholds.
TWIN = {
    "bullish_engulfing": "bearish_engulfing",
    "bearish_engulfing": "bullish_engulfing",
    "bullish_harami": "bearish_harami",
    "bearish_harami": "bullish_harami",
    "piercing_line": "dark_cloud_cover",
    "dark_cloud_cover": "piercing_line",
    "tweezer_bottom": "tweezer_top",
    "tweezer_top": "tweezer_bottom",
}
TWIN_PAIRS = [
    ("bullish_engulfing", "bearish_engulfing"),
    ("bullish_harami", "bearish_harami"),
    ("piercing_line", "dark_cloud_cover"),
    ("tweezer_bottom", "tweezer_top"),
]

# Bars are (open, high, low, close). Each clear setup is (prior candle, completing candle).
CLEAR = {
    "bullish_engulfing": ((10.0, 10.2, 8.8, 9.0), (8.8, 10.8, 8.6, 10.6)),
    "bullish_harami": ((10.0, 10.2, 8.8, 9.0), (9.2, 9.6, 9.1, 9.8)),
    "piercing_line": ((10.0, 10.2, 8.8, 9.0), (8.8, 9.9, 8.7, 9.7)),
    "tweezer_bottom": ((10.0, 10.4, 9.0, 9.2), (9.3, 10.0, 9.0, 9.9)),
    "inside_bar": ((10.0, 11.0, 9.0, 10.5), (10.2, 10.8, 9.5, 10.0)),
}
CLEAR_CASES = [("clear", name, prior, current) for name, (prior, current) in CLEAR.items()]

# Each breaks exactly one condition of the bullish pattern named in the second column.
NEAR_MISSES = [
    ("equal-body", "bullish_engulfing", (10.0, 10.2, 8.8, 9.0), (9.0, 10.2, 8.9, 10.0)),
    ("open-just-above-prior-close", "bullish_engulfing", (10.0, 10.2, 8.8, 9.0), (9.01, 10.8, 8.6, 10.6)),
    ("close-just-below-prior-open", "bullish_engulfing", (10.0, 10.2, 8.8, 9.0), (8.8, 10.8, 8.6, 9.99)),
    ("prior-not-opposite-color", "bullish_engulfing", (9.0, 10.2, 8.8, 10.0), (8.8, 10.8, 8.6, 10.6)),
    ("first-body-under-half", "bullish_harami", (10.0, 10.6, 8.4, 9.0), (9.2, 9.6, 9.1, 9.8)),
    ("open-just-below-prior-close", "bullish_harami", (10.0, 10.2, 8.8, 9.0), (8.99, 9.6, 8.9, 9.8)),
    ("close-just-above-prior-open", "bullish_harami", (10.0, 10.2, 8.8, 9.0), (9.2, 10.05, 9.1, 10.01)),
    ("equal-body", "bullish_harami", (10.0, 10.2, 8.8, 9.0), (9.0, 10.1, 8.9, 10.0)),
    ("open-above-prior-close", "piercing_line", (10.0, 10.2, 8.8, 9.0), (9.05, 9.9, 8.7, 9.7)),
    ("close-below-midpoint", "piercing_line", (10.0, 10.2, 8.8, 9.0), (8.8, 9.9, 8.7, 9.4)),
    ("close-at-midpoint", "piercing_line", (10.0, 10.2, 8.8, 9.0), (8.8, 9.9, 8.7, 9.5)),
    ("close-at-prior-open", "piercing_line", (10.0, 10.2, 8.8, 9.0), (8.8, 10.1, 8.7, 10.0)),
    ("close-above-prior-open", "piercing_line", (10.0, 10.2, 8.8, 9.0), (8.8, 10.3, 8.7, 10.1)),
    ("prior-not-bearish", "tweezer_bottom", (9.2, 10.4, 9.0, 10.0), (9.3, 10.0, 9.0, 9.9)),
    ("completing-not-bullish", "tweezer_bottom", (10.0, 10.4, 9.0, 9.2), (9.9, 10.0, 9.0, 9.3)),
    ("equal-high", "inside_bar", (10.0, 11.0, 9.0, 10.5), (10.2, 11.0, 9.5, 10.0)),
    ("equal-low", "inside_bar", (10.0, 11.0, 9.0, 10.5), (10.2, 10.8, 9.0, 10.0)),
]


def frame(*rows: tuple[float, float, float, float]) -> pd.DataFrame:
    """Bars as (open, high, low, close), oldest first, 15 minutes apart."""
    return pd.DataFrame(
        rows,
        columns=["open", "high", "low", "close"],
        index=pd.date_range("2026-10-06 14:30", periods=len(rows), freq="15min", tz="UTC"),
    )


def flip(bar: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    o, h, low, c = bar
    return (100 - o, 100 - low, 100 - h, 100 - c)


def flat(price: float) -> tuple[float, float, float, float]:
    """A candle with no range (high == low)."""
    return (price, price, price, price)


def completes(bars: pd.DataFrame, name: str) -> bool:
    """Whether `name` completes on the last bar."""
    return bool(patterns.geometry(bars, name)[-1])


def clear_setup(name: str) -> tuple[tuple[float, ...], tuple[float, ...]]:
    """(prior, completing) bars of a clear setup for any of the nine patterns."""
    if name in CLEAR:
        return CLEAR[name]
    prior, current = CLEAR[TWIN[name]]
    return flip(prior), flip(current)


def twin_params(cases):
    """Each `(label, name, prior, current, *extra)` case as written, plus its bearish twin with the bars flipped."""
    params = []
    for label, name, prior, current, *extra in cases:
        params.append(pytest.param(name, prior, current, *extra, id=f"{name}-{label}"))
        if name in TWIN:
            twin = TWIN[name]
            params.append(pytest.param(twin, flip(prior), flip(current), *extra, id=f"{twin}-{label}"))
    return params


ZERO_RANGE_CASES = [
    ("zero-range-prior", "bullish_engulfing", flat(9.0), (8.8, 10.8, 8.6, 10.6)),
    ("zero-range-prior", "bullish_harami", flat(9.0), (9.2, 9.6, 9.1, 9.8)),
    ("zero-range-prior", "piercing_line", flat(9.0), (8.8, 9.9, 8.7, 9.7)),
    ("zero-range-prior", "tweezer_bottom", flat(9.0), (9.3, 10.0, 9.0, 9.9)),
    ("zero-range-prior", "inside_bar", flat(10.5), (10.2, 10.8, 9.5, 10.0)),
]

# Tweezer tolerance: 10% of the mean of the two candles' ranges. Prior range 1.4 and completing range 1.0 give 0.12.
# The wide pair (2.0 and 0.4, mean 1.2, so 0.12 again) separates the mean from either candle's own range.
TOLERANCE_CASES = [
    ("just-inside", "tweezer_bottom", (10.0, 10.4, 9.0, 9.2), (9.3, 10.108, 9.108, 9.9), True),
    ("just-outside", "tweezer_bottom", (10.0, 10.4, 9.0, 9.2), (9.3, 10.132, 9.132, 9.9), False),
    ("mean-range-inside", "tweezer_bottom", (10.0, 11.0, 9.0, 9.2), (9.2, 9.5, 9.1, 9.4), True),
    ("mean-range-outside", "tweezer_bottom", (10.0, 11.0, 9.0, 9.2), (9.25, 9.55, 9.15, 9.45), False),
]

# Trend cases: four lead-in bars, then a bullish engulfing (first candle, completing candle). With trend_bars=3
# the bar before the first candle is lead bar 4 and is compared with lead bar 1.
DOWN_LEAD = [(10.1, 10.2, 9.9, 10.0), (10.0, 10.05, 9.7, 9.8), (9.8, 9.85, 9.5, 9.6), (9.6, 9.65, 9.3, 9.4)]
UP_LEAD = [(8.7, 8.9, 8.6, 8.8), (8.8, 9.1, 8.7, 9.0), (9.0, 9.3, 8.9, 9.2), (9.2, 9.5, 9.1, 9.4)]
FLAT_LEAD = [(9.6, 9.7, 9.3, 9.4)] * 4
# Closes 10.0, 9.0, 9.8, 9.4: the bar before the first candle (9.4) is below the close three bars earlier (10.0)
# but not below the close two bars earlier (9.0), so a one-bar-short lag gives the wrong answer.
ZIGZAG_LEAD = [(10.1, 10.2, 9.9, 10.0), (9.2, 9.3, 8.9, 9.0), (9.6, 9.9, 9.5, 9.8), (9.6, 9.65, 9.3, 9.4)]
ENGULFING = [(9.4, 9.6, 8.2, 8.4), (8.2, 10.2, 8.0, 10.0)]
PRE_BAR = (9.1, 9.2, 8.9, 9.0)
TREND_CASES = [
    pytest.param(frame(*DOWN_LEAD, *ENGULFING), "bullish_engulfing", "after_downtrend", True, id="falling-fires"),
    pytest.param(frame(*ZIGZAG_LEAD, *ENGULFING), "bullish_engulfing", "after_downtrend", True, id="zigzag-fires"),
    pytest.param(frame(*UP_LEAD, *ENGULFING), "bullish_engulfing", "after_downtrend", False, id="rising-no"),
    pytest.param(frame(*FLAT_LEAD, *ENGULFING), "bullish_engulfing", "after_downtrend", False, id="flat-no"),
    pytest.param(frame(*DOWN_LEAD, *ENGULFING), "bullish_engulfing", "after_uptrend", False, id="falling-up-no"),
    pytest.param(frame(*UP_LEAD, *ENGULFING), "bullish_engulfing", "after_uptrend", True, id="rising-up-fires"),
    pytest.param(
        frame(*map(flip, DOWN_LEAD), *map(flip, ENGULFING)),
        "bearish_engulfing",
        "after_uptrend",
        True,
        id="mirrored-falling-up-fires",
    ),
    pytest.param(
        frame(*map(flip, DOWN_LEAD), *map(flip, ENGULFING)),
        "bearish_engulfing",
        "after_downtrend",
        False,
        id="mirrored-falling-down-no",
    ),
    pytest.param(
        frame(PRE_BAR, *DOWN_LEAD, *ENGULFING),
        "bullish_engulfing",
        "after_downtrend",
        True,
        id="seven-bars-fires",
    ),
]


@pytest.mark.parametrize(("name", "prior", "current"), twin_params(CLEAR_CASES))
def test_clear_setup_completes_on_the_second_bar(name, prior, current):
    assert patterns.geometry(frame(prior, current), name).tolist() == [False, True]


@pytest.mark.parametrize(("name", "prior", "current"), twin_params(CLEAR_CASES))
def test_first_bar_never_matches_without_a_prior_candle(name, prior, current):
    assert patterns.geometry(frame(current), name).tolist() == [False]


@pytest.mark.parametrize(("name", "prior", "current"), twin_params(ZERO_RANGE_CASES))
def test_zero_range_prior_blocks_the_pattern(name, prior, current):
    assert not completes(frame(prior, current), name)


@pytest.mark.parametrize(("name", "prior", "current"), twin_params(NEAR_MISSES))
def test_near_miss_does_not_complete(name, prior, current):
    assert not completes(frame(prior, current), name)


@pytest.mark.parametrize(("name", "prior", "current", "fires"), twin_params(TOLERANCE_CASES))
def test_tweezer_tolerance_is_ten_percent_of_mean_range(name, prior, current, fires):
    assert completes(frame(prior, current), name) is fires


def test_harami_first_body_of_exactly_half_its_range_counts_as_long():
    assert completes(frame((10.0, 10.5, 8.5, 9.0), (9.2, 9.6, 9.1, 9.8)), "bullish_harami")


@pytest.mark.parametrize(("bullish", "bearish"), TWIN_PAIRS)
def test_twins_do_not_fire_on_each_others_setup(bullish, bearish):
    bull_bars = frame(*clear_setup(bullish))
    bear_bars = frame(*clear_setup(bearish))
    assert completes(bull_bars, bullish)
    assert not completes(bull_bars, bearish)
    assert completes(bear_bars, bearish)
    assert not completes(bear_bars, bullish)


def test_inside_bar_ignores_color_and_needs_strictly_inside_bars():
    prior = (10.0, 11.0, 9.0, 10.5)
    assert completes(frame(prior, (10.2, 10.8, 9.5, 10.0)), "inside_bar")  # bearish inside bar
    assert completes(frame(prior, (10.0, 10.8, 9.5, 10.2)), "inside_bar")  # bullish inside bar


def test_detect_truth_is_na_only_on_undecided_bars():
    truth = patterns.detect(frame(*CLEAR["bullish_engulfing"], *CLEAR["bullish_engulfing"]), "bullish_engulfing").truth
    assert truth.dtype == "boolean"
    assert truth.isna().tolist() == [True, False, False, False]


def test_detect_truth_is_false_on_decided_bars_that_do_not_complete():
    prior, current = CLEAR["bullish_engulfing"]
    truth = patterns.detect(frame(prior, current, prior, current), "bullish_engulfing").truth
    assert truth.dropna().tolist() == [True, False, True]


def test_detect_completed_at_points_at_the_completing_rows():
    prior, current = CLEAR["bullish_engulfing"]
    completed = patterns.detect(frame(prior, current, prior, current), "bullish_engulfing").completed_at
    assert completed.isna().tolist() == [True, False, True, False]
    assert completed.dropna().tolist() == [1, 3]


@pytest.mark.parametrize(("bars", "name", "trend", "fires"), TREND_CASES)
def test_trend_rule_reads_the_bar_before_the_first_candle(bars, name, trend, fires):
    detection = patterns.detect(bars, name, trend=trend, trend_bars=3)
    assert bool(detection.completed_at.notna().iloc[-1]) is fires
    occurrences = patterns.occurrences(bars, name, trend=trend, trend_bars=3)
    assert [occurrence.bar_time for occurrence in occurrences] == ([bars.index[-1]] if fires else [])


def test_detect_truth_on_the_trend_firing_bar():
    bars = frame(*DOWN_LEAD, *ENGULFING)
    truth = patterns.detect(bars, "bullish_engulfing", trend="after_downtrend", trend_bars=3).truth
    assert truth.dtype == "boolean"
    assert truth.isna().tolist() == [True] * 5 + [False]
    assert bool(truth.iloc[-1])


def test_occurrences_report_completing_bar_and_the_bar_before_it():
    prior, current = CLEAR["bullish_engulfing"]
    bars = frame(prior, current, prior, current)
    occurrences = patterns.occurrences(bars, "bullish_engulfing")
    assert [occurrence.bar_time for occurrence in occurrences] == [bars.index[1], bars.index[3]]
    assert [occurrence.first_bar_time for occurrence in occurrences] == [bars.index[0], bars.index[2]]
    assert all(occurrence.pattern == "bullish_engulfing" for occurrence in occurrences)


def test_occurrence_evidence_describes_the_completing_candle():
    prior, current = CLEAR["bullish_engulfing"]
    (occurrence,) = patterns.occurrences(frame(prior, current), "bullish_engulfing")
    assert set(occurrence.evidence) == {"open", "high", "low", "close", "bodyPct", "upperWickPct", "lowerWickPct"}
    assert occurrence.evidence["open"] == 8.8
    assert occurrence.evidence["close"] == 10.6
    # range 2.2, body 1.8, upper wick 0.2 (above the close), lower wick 0.2 (below the open)
    assert occurrence.evidence["bodyPct"] == pytest.approx(100 * 1.8 / 2.2, abs=1e-5)
    assert occurrence.evidence["upperWickPct"] == pytest.approx(100 * 0.2 / 2.2, abs=1e-5)
    assert occurrence.evidence["lowerWickPct"] == pytest.approx(100 * 0.2 / 2.2, abs=1e-5)
