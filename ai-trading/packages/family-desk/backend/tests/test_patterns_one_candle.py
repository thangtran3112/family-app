"""Hand-made OHLC checks for the seven one-candle patterns in core/patterns.py.

The labelled table candles have high 100 and low 90 (range 10), so a price distance of 2.5 is 25% of range.
Each table row is (label, (open, high, low, close), expected truth); near-misses violate one threshold.
"""

import numpy as np
import pandas as pd
import pytest

from ai_trading.core import patterns

HAMMER = (97.0, 100.0, 90.0, 99.5)  # body 25%, upper wick 5%, lower wick 70%

# hammer and hanging_man: body >= 10%, lower wick >= 2x body, upper wick <= 10%
LONG_LOWER_WICK = [
    ("bullish", HAMMER, True),
    ("bearish", (99.5, 100.0, 90.0, 97.0), True),
    ("body_9pct", (98.6, 100.0, 90.0, 99.5), False),  # body 0.9 is under 10%
    ("lower_wick_under_2x_body", (96.2, 100.0, 90.0, 99.6), False),  # lower 6.2 < 2 * body 3.4
    ("upper_wick_11pct", (96.9, 100.0, 90.0, 98.9), False),
]
# inverted_hammer and shooting_star: the mirror of the above
LONG_UPPER_WICK = [
    ("bullish", (90.5, 100.0, 90.0, 93.0), True),
    ("bearish", (93.0, 100.0, 90.0, 90.5), True),
    ("body_9pct", (90.5, 100.0, 90.0, 91.4), False),
    ("upper_wick_under_2x_body", (90.4, 100.0, 90.0, 93.8), False),  # upper 6.2 < 2 * body 3.4
    ("lower_wick_11pct", (91.1, 100.0, 90.0, 93.1), False),
]
# doji: body <= 10%, nothing else
DOJI = [
    ("symmetric", (95.0, 100.0, 90.0, 95.0), True),
    ("body_11pct", (95.0, 100.0, 90.0, 96.1), False),
    ("body_40pct", (94.0, 100.0, 90.0, 98.0), False),
]
# dragonfly: doji, lower wick >= 60%, upper wick <= 10%. The 60% floor cannot be broken alone:
# body <= 10% and upper <= 10% already force the lower wick to be >= 80%.
DRAGONFLY = [
    ("lower_wick_95pct", (99.5, 100.0, 90.0, 99.5), True),
    ("body_15pct", (98.0, 100.0, 90.0, 99.5), False),
    ("upper_wick_11pct", (98.9, 100.0, 90.0, 98.9), False),
]
# gravestone: the mirror of dragonfly
GRAVESTONE = [
    ("upper_wick_95pct", (90.5, 100.0, 90.0, 90.5), True),
    ("body_15pct", (90.5, 100.0, 90.0, 92.0), False),
    ("lower_wick_11pct", (91.1, 100.0, 90.0, 91.1), False),
]

FALLING_RUN = [
    (111.0, 111.5, 109.5, 110.0),
    (109.0, 109.5, 107.5, 108.0),
    (107.0, 107.5, 105.5, 106.0),
    (105.0, 105.5, 103.5, 104.0),
    (103.0, 103.5, 101.5, 102.0),
]
RISING_RUN = [
    (89.0, 90.5, 88.5, 90.0),
    (91.0, 92.5, 90.5, 92.0),
    (93.0, 94.5, 92.5, 94.0),
    (95.0, 96.5, 94.5, 96.0),
    (97.0, 98.5, 96.5, 98.0),
]
FLAT = (95.0, 95.0, 95.0, 95.0)  # high == low


def _bars(rows: list[tuple[float, float, float, float]]) -> pd.DataFrame:
    return pd.DataFrame(
        rows,
        columns=["open", "high", "low", "close"],
        index=pd.date_range("2026-10-06 14:30", periods=len(rows), freq="15min", tz="UTC"),
    )


def _labelled(pattern: str, table: list[tuple]) -> dict[str, bool]:
    got = patterns.geometry(_bars([ohlc for _, ohlc, _ in table]), pattern)
    return dict(zip((label for label, _, _ in table), got.tolist(), strict=True))


@pytest.mark.parametrize(
    ("pattern", "table"),
    [
        ("hammer", LONG_LOWER_WICK),
        ("hanging_man", LONG_LOWER_WICK),
        ("inverted_hammer", LONG_UPPER_WICK),
        ("shooting_star", LONG_UPPER_WICK),
        ("doji", DOJI),
        ("dragonfly_doji", DRAGONFLY),
        ("gravestone_doji", GRAVESTONE),
    ],
)
def test_geometry_matches_each_labelled_candle(pattern, table):
    assert _labelled(pattern, table) == {label: want for label, _, want in table}


@pytest.mark.parametrize(("first", "second"), [("hammer", "hanging_man"), ("inverted_hammer", "shooting_star")])
def test_paired_patterns_have_identical_geometry(first, second):
    bars = _bars([ohlc for _, ohlc, _ in LONG_LOWER_WICK + LONG_UPPER_WICK])
    assert patterns.geometry(bars, first).any()
    assert np.array_equal(patterns.geometry(bars, first), patterns.geometry(bars, second))


@pytest.mark.parametrize(
    ("pattern", "trend", "run", "expected"),
    [
        ("hammer", "after_downtrend", FALLING_RUN, True),
        ("hammer", "after_downtrend", RISING_RUN, False),
        ("hanging_man", "after_uptrend", RISING_RUN, True),
        ("hanging_man", "after_uptrend", FALLING_RUN, False),
    ],
)
def test_trend_separates_hammer_from_hanging_man(pattern, trend, run, expected):
    det = patterns.detect(_bars([*run, HAMMER]), pattern, trend=trend, trend_bars=3)
    assert det.truth.iloc[-1] == expected


def test_truth_is_unknown_until_trend_history_exists():
    det = patterns.detect(_bars([*FALLING_RUN, HAMMER]), "hammer", trend="after_downtrend", trend_bars=3)
    assert det.truth.iloc[:4].isna().all()
    assert det.completed_at.iloc[:5].isna().all()


def test_completed_at_points_at_the_hammer_row():
    det = patterns.detect(_bars([*FALLING_RUN, HAMMER]), "hammer", trend="after_downtrend", trend_bars=3)
    assert det.completed_at.iloc[-1] == 5


def test_detect_is_false_on_a_bar_that_does_not_match():
    bars = _bars([DOJI[0][1], DOJI[1][1]])  # a doji, then a candle with an 11% body
    assert patterns.detect(bars, "doji").truth.tolist() == [True, False]


def test_dragonfly_and_gravestone_are_dojis_on_one_wick_side():
    bars = _bars([DRAGONFLY[0][1], GRAVESTONE[0][1], DOJI[0][1]])
    doji, dragonfly, gravestone = (
        patterns.geometry(bars, name) for name in ("doji", "dragonfly_doji", "gravestone_doji")
    )
    assert doji.tolist() == [True, True, True]
    assert dragonfly.tolist() == [True, False, False]
    assert gravestone.tolist() == [False, True, False]


def test_wick_dojis_are_always_dojis():
    bars = _bars([ohlc for table in (DOJI, DRAGONFLY, GRAVESTONE) for _, ohlc, _ in table])
    doji = patterns.geometry(bars, "doji")
    assert not (patterns.geometry(bars, "dragonfly_doji") & ~doji).any()
    assert not (patterns.geometry(bars, "gravestone_doji") & ~doji).any()


@pytest.mark.parametrize("pattern", sorted(patterns.PATTERN_CANDLES))
def test_flat_candle_matches_no_pattern(pattern):
    # the flat candle sits inside the prior range, so inside_bar would match it without the range guard
    got = patterns.geometry(_bars([HAMMER, FLAT, HAMMER]), pattern)
    assert not got[1]
    if patterns.PATTERN_CANDLES[pattern] > 1:
        assert not got[2]  # its prior candle is flat, so it cannot complete


def test_occurrences_report_the_completing_candle():
    bars = _bars([DOJI[0][1], HAMMER, LONG_LOWER_WICK[2][1]])
    [occurrence] = patterns.occurrences(bars, "hammer")
    assert occurrence.pattern == "hammer"
    assert occurrence.bar_time == bars.index[1]
    assert occurrence.first_bar_time == occurrence.bar_time
    assert occurrence.evidence == pytest.approx(
        {
            "open": 97.0,
            "high": 100.0,
            "low": 90.0,
            "close": 99.5,
            "bodyPct": 25.0,
            "upperWickPct": 5.0,
            "lowerWickPct": 70.0,
        }
    )


def test_unknown_pattern_raises_key_error():
    with pytest.raises(KeyError):
        patterns.geometry(_bars([HAMMER]), "not_a_pattern")
