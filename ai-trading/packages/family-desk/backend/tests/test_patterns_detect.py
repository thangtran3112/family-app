"""Three-candle patterns (morning/evening star, three white soldiers/black crows) and the `detect()`
semantics shared by every pattern. Prices are hand-made; comments give the arithmetic behind a threshold."""

from typing import get_args

import pandas as pd
import pytest

from ai_trading.contracts.strategy_spec_v1 import PatternCondition
from ai_trading.core import patterns

Candle = tuple[float, float, float, float]  # (open, high, low, close)


def _bars(candles: list[Candle]) -> pd.DataFrame:
    return pd.DataFrame(
        candles,
        columns=["open", "high", "low", "close"],
        index=pd.date_range("2026-10-06 14:30", periods=len(candles), freq="15min", tz="UTC"),
    )


def _flat(close: float) -> Candle:
    """A candle with no body: it can never be the first or last candle of a three-candle pattern."""
    return (close, close + 1, close - 1, close)


def _mirror(candles: list[Candle]) -> list[Candle]:
    """Reflect prices about 105: a bullish candle turns bearish and a lower wick becomes an upper one."""
    return [(210 - o, 210 - low, 210 - high, 210 - c) for o, high, low, c in candles]


def _states(truth: pd.Series) -> str:
    """One character per row: 'T', 'F', or '-' for NA."""
    return "".join("-" if pd.isna(v) else ("T" if v else "F") for v in truth)


def _positions(completed: pd.Series) -> list[int | None]:
    return [None if pd.isna(v) else int(v) for v in completed]


MORNING_STAR: list[Candle] = [(110, 110, 100, 100), (98, 99, 96, 97), (99, 107, 98, 106)]
THREE_WHITE_SOLDIERS: list[Candle] = [(100, 110, 99, 109), (105, 115, 104, 114), (110, 122, 109, 121)]

POSITIVE = {
    "morning_star": MORNING_STAR,
    "evening_star": _mirror(MORNING_STAR),
    "three_white_soldiers": THREE_WHITE_SOLDIERS,
    "three_black_crows": _mirror(THREE_WHITE_SOLDIERS),
}

# Each case breaks exactly one condition of the bullish positive above.
MORNING_STAR_MISSES: dict[str, list[Candle]] = {
    "first body 49% of range": [(104.9, 110, 100, 100), (98, 99, 96, 97), (99, 107, 98, 106)],
    "star body 31% of first body": [(110, 110, 100, 100), (98, 99, 94, 94.9), (99, 107, 98, 106)],
    "third close 104.9, short of first midpoint 105": [(110, 110, 100, 100), (98, 99, 96, 97), (99, 104, 98, 104.9)],
    "star body not below first close": [(110, 110, 100, 100), (101, 103, 100, 102), (99, 107, 98, 106)],
}
SOLDIER_MISSES: dict[str, list[Candle]] = {
    "third opens above second close": [(100, 110, 99, 109), (105, 115, 104, 114), (115, 122, 114, 121)],
    "second opens below first open": [(100, 110, 99, 109), (99, 115, 98, 114), (110, 122, 109, 121)],
    "third upper wick 4 over 30% of body 11": [(100, 110, 99, 109), (105, 115, 104, 114), (110, 125, 109, 121)],
    "second body 45% of range": [(100, 110, 99, 109), (105, 115, 95, 114), (110, 122, 109, 121)],
    "third close not above second close": [(100, 110, 99, 109), (105, 115, 104, 114), (106, 113, 105, 112)],
}
NEAR_MISSES: dict[str, dict[str, list[Candle]]] = {
    "morning_star": MORNING_STAR_MISSES,
    "evening_star": {label: _mirror(c) for label, c in MORNING_STAR_MISSES.items()},
    "three_white_soldiers": SOLDIER_MISSES,
    "three_black_crows": {label: _mirror(c) for label, c in SOLDIER_MISSES.items()},
}

# Just inside a threshold: each one matches, so the limits are not off by a strict/loose comparison.
JUST_INSIDE: list[tuple[str, list[Candle]]] = [
    ("morning_star", [(105.1, 110, 100, 100), (98, 99, 96, 97), (99, 107, 98, 106)]),  # first body 51%
    ("morning_star", [(110, 110, 100, 100), (98, 99, 95, 95.1), (99, 107, 98, 106)]),  # star body 29%
    ("three_white_soldiers", [(100, 110, 99, 109), (105, 115, 104, 114), (110, 122.9, 109, 120)]),  # wick 29%
]
MIRROR_NAME = {"morning_star": "evening_star", "three_white_soldiers": "three_black_crows"}

# A middle candle with no range, set to a price that would otherwise pass the star's other conditions.
ZERO_RANGE_MIDDLE = {
    "morning_star": (97, 97, 97, 97),
    "evening_star": (113, 113, 113, 113),
    "three_white_soldiers": (105, 105, 105, 105),
    "three_black_crows": (105, 105, 105, 105),
}

# Closes of rows 0-7 for a pattern whose first candle is row 8 and which completes on row 10.
# Row 7 is the bar before the first candle; row 2 is trend_bars (5) earlier than row 7. The nearby
# bars are set so that an off-by-one choice gives the wrong answer.
DOWNTREND_HOLDS = [100, 100, 120, 90, 100, 100, 130, 110]  # close[7] < close[2]
DOWNTREND_FAILS = [100, 135, 100, 105, 100, 100, 130, 110]  # close[7] > close[2]
UPTREND_HOLDS = [100, 135, 100, 120, 100, 100, 130, 110]  # close[7] > close[2]
UPTREND_FAILS = [100, 100, 120, 100, 100, 100, 130, 110]  # close[7] < close[2]


@pytest.mark.parametrize("name", list(POSITIVE))
def test_clear_pattern_completes_on_the_third_candle(name):
    """Rows 0 and 1 have no three-candle history, so only row 2 can match."""
    assert patterns.geometry(_bars(POSITIVE[name]), name).tolist() == [False, False, True]


@pytest.mark.parametrize(
    ("name", "candles"),
    [pytest.param(n, c, id=f"{n}: {label}") for n, cases in NEAR_MISSES.items() for label, c in cases.items()],
)
def test_one_broken_condition_is_not_a_match(name, candles):
    assert not patterns.geometry(_bars(candles), name).any()


@pytest.mark.parametrize(
    ("name", "candles"),
    [(n, c) for n, c in JUST_INSIDE] + [(MIRROR_NAME[n], _mirror(c)) for n, c in JUST_INSIDE],
)
def test_just_inside_a_threshold_is_a_match(name, candles):
    assert patterns.geometry(_bars(candles), name)[2]


@pytest.mark.parametrize("name", list(POSITIVE))
def test_zero_range_middle_candle_blocks_the_pattern(name):
    candles = list(POSITIVE[name])
    assert patterns.geometry(_bars(candles), name)[2]  # the unmodified pattern does match
    candles[1] = ZERO_RANGE_MIDDLE[name]
    assert not patterns.geometry(_bars(candles), name).any()


@pytest.mark.parametrize(
    ("trend", "expected_states"),
    [(None, "--T"), ("any", "--T"), ("after_downtrend", "---")],
)
def test_no_trend_history_is_unknown_not_false(trend, expected_states):
    bars = _bars(MORNING_STAR)
    truth = patterns.detect(bars, "morning_star", trend=trend).truth
    assert truth.dtype == "boolean"
    assert truth.index.equals(bars.index)
    assert _states(truth) == expected_states


@pytest.mark.parametrize("trend_bars", [3, 5])
def test_trend_needs_candles_plus_trend_bars_rows_of_history(trend_bars):
    history = 3 + trend_bars
    closes = [200 - i for i in range(history)]  # falling, so after_downtrend holds on the completing bar
    bars = _bars([_flat(c) for c in closes] + MORNING_STAR)
    truth = patterns.detect(bars, "morning_star", trend="after_downtrend", trend_bars=trend_bars).truth
    assert _states(truth) == "-" * history + "FFT"


@pytest.mark.parametrize(
    ("name", "candles", "trend", "closes", "expected"),
    [
        ("morning_star", POSITIVE["morning_star"], "after_downtrend", DOWNTREND_HOLDS, True),
        ("morning_star", POSITIVE["morning_star"], "after_downtrend", DOWNTREND_FAILS, False),
        ("evening_star", POSITIVE["evening_star"], "after_uptrend", UPTREND_HOLDS, True),
        ("evening_star", POSITIVE["evening_star"], "after_uptrend", UPTREND_FAILS, False),
    ],
)
def test_trend_reads_the_bar_before_the_first_candle(name, candles, trend, closes, expected):
    bars = _bars([_flat(c) for c in closes] + candles)
    truth = patterns.detect(bars, name, trend=trend).truth
    assert truth.tolist()[-1] is expected


@pytest.mark.parametrize("trend", ["any", None])
def test_any_or_no_trend_checks_nothing(trend):
    bars = _bars([_flat(c) for c in DOWNTREND_FAILS] + MORNING_STAR)
    assert _states(patterns.detect(bars, "morning_star", trend=trend).truth) == "--" + "F" * 8 + "T"


def test_within_bars_holds_the_match_for_n_bars():
    bars = _bars([_flat(50)] * 4 + MORNING_STAR + [_flat(50)] * 5)  # the star completes on row 6
    detection = patterns.detect(bars, "morning_star", within_bars=3)
    assert _states(detection.truth)[:2] == "--"  # the window starts before row 0
    assert _states(detection.truth)[4:] == "FFTTTFFF"  # true on rows 6-8, then false again
    assert _positions(detection.completed_at) == [None] * 6 + [6, 6, 6] + [None] * 3


def test_completed_at_is_the_latest_completing_bar_in_the_window():
    bars = _bars([_flat(50)] + MORNING_STAR + MORNING_STAR + [_flat(50)] * 5)  # the stars complete on rows 3, 6
    detection = patterns.detect(bars, "morning_star", within_bars=4)
    assert _states(detection.truth) == "---" + "T" * 7 + "FF"
    assert _positions(detection.completed_at) == [None] * 3 + [3, 3, 3, 6, 6, 6, 6] + [None] * 2


def test_within_bars_one_is_the_plain_geometry_and_trend():
    closes = [150, 140, 130, 120, 110, 100]  # falling, so after_downtrend holds only on the first star
    bars = _bars([_flat(c) for c in closes] + MORNING_STAR + MORNING_STAR)
    truth = patterns.detect(bars, "morning_star", trend="after_downtrend", trend_bars=3).truth
    plain = patterns.geometry(bars, "morning_star") & patterns.trend_holds(bars, "morning_star", "after_downtrend", 3)
    assert truth.iloc[6:].tolist() == plain[6:].tolist()
    assert _states(truth) == "------FFTFFF"


@pytest.mark.parametrize("name", list(POSITIVE))
def test_occurrence_points_back_two_rows_to_the_first_candle(name):
    bars = _bars([_flat(50)] + POSITIVE[name])  # completes on row 3, first candle on row 1
    (occurrence,) = patterns.occurrences(bars, name)
    assert occurrence.bar_time == bars.index[3]
    assert occurrence.first_bar_time == bars.index[1]


def test_occurrences_apply_the_trend_rule():
    holds = _bars([_flat(c) for c in DOWNTREND_HOLDS] + MORNING_STAR)
    fails = _bars([_flat(c) for c in DOWNTREND_FAILS] + MORNING_STAR)
    (occurrence,) = patterns.occurrences(holds, "morning_star", trend="after_downtrend")
    assert occurrence.bar_time == holds.index[10]
    assert occurrence.first_bar_time == holds.index[8]
    assert patterns.occurrences(fails, "morning_star", trend="after_downtrend") == []


def test_pattern_ids_match_the_contract():
    contract_ids = set(get_args(PatternCondition.model_fields["pattern"].annotation))
    assert len(contract_ids) == 20
    assert set(patterns.PATTERN_CANDLES) == contract_ids


TWELVE_ROWS: list[Candle] = [
    (100, 105, 99, 104),
    (104, 106, 102, 103),
    (103, 107, 101, 106),
    (106, 108, 104, 105),
    (105, 110, 103, 109),
    (109, 110, 106, 107),
    (107, 107, 107, 107),  # no range
    (107, 112, 106, 111),
    (111, 113, 108, 109),
    (109, 111, 105, 106),
    (106, 109, 104, 108),
    (108, 112, 107, 111),
]


@pytest.mark.parametrize("name", sorted(patterns.PATTERN_CANDLES))
def test_every_pattern_runs_on_a_twelve_row_frame(name):
    bars = _bars(TWELVE_ROWS)
    geometry = patterns.geometry(bars, name)
    assert geometry.shape == (12,)
    detection = patterns.detect(bars, name, trend="after_downtrend", within_bars=2)
    assert detection.truth.dtype == "boolean"
    assert detection.completed_at.dtype == "Int64"
    assert len(detection.truth) == len(detection.completed_at) == 12
    assert isinstance(patterns.occurrences(bars, name), list)


def test_unknown_pattern_raises_key_error():
    bars = _bars(MORNING_STAR)
    for call in (patterns.geometry, patterns.detect, patterns.occurrences):
        with pytest.raises(KeyError):
            call(bars, "not_a_pattern")
