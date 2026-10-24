"""`pattern` conditions and running session levels in evaluate(), and their check() rules. Synthetic prices."""

from datetime import date
from typing import Any, get_args

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1, PatternCondition, StrategySpecV1
from ai_trading.core.calendar import et
from ai_trading.core.evaluate import check, check_filter, evaluate

DAY = date(2026, 10, 6)
CLOSE = {"series": "close"}
PATTERN_IDS = get_args(PatternCondition.model_fields["pattern"].annotation)
CANDLE_FIELDS = ("open", "high", "low", "close", "bodyPct", "upperWickPct", "lowerWickPct")
PATTERN_REJECTED = "the pattern condition is not supported by the engine yet"

Candle = tuple[float, float, float, float]  # open, high, low, close


def solid(o: float, c: float) -> Candle:
    """A candle with no wicks: its high and low are its own open and close."""
    return (o, max(o, c), min(o, c), c)


HAMMER = {"op": "pattern", "pattern": "hammer"}
HAMMER_RULE = {**HAMMER, "trend": "after_downtrend", "trendBars": 3}
ENGULFING = {"op": "pattern", "pattern": "bullish_engulfing"}
# body 0.20, lower wick 1.20, upper wick 0.05, range 1.45
HAMMER_BAR: Candle = (96.2, 96.45, 95.0, 96.4)


def series(closes: list[float]) -> dict[str, Candle]:
    """Four solid 15-minute candles from 09:30 with these closes; the first opens at 100."""
    opens = [100.0, *closes[:-1]]
    hhmm = ["09:30", "09:45", "10:00", "10:15"]
    return {at: solid(o, c) for at, o, c in zip(hhmm, opens, closes, strict=True)}


# The four closes before a hammer at 10:30. The trend rule compares the close before the hammer (10:15)
# with the close three bars before that (09:30); the zigzags make the wrong offsets disagree with it.
FALLING = series([99.0, 98.0, 97.0, 96.0])
RISING = series([97.0, 98.0, 99.0, 100.0])
ZIGZAG_DOWN = series([99.0, 101.0, 100.0, 98.0])  # 98 < 99 is a downtrend; the close two bars back (100) is not
ZIGZAG_FLAT = series([99.0, 101.0, 100.0, 100.5])  # 100.5 > 99 is not; against the close three back (101) it is


def paint(bars: pd.DataFrame, day: date, hhmm: str, candle: Candle) -> None:
    """Makes the 15 one-minute bars from HH:MM aggregate into one 15-minute candle with these prices.
    The first minute carries the open and the high and low, the middle minutes sit between the open
    and the close, and the last minute carries the close."""
    o, h, low, c = candle
    start = et(day, hhmm)
    for minute in range(15):
        if minute == 0:
            values = [o, h, low, o]
        elif minute < 14:
            values = [(o + c) / 2] * 4
        else:
            values = [c] * 4
        bars.loc[start + pd.Timedelta(minutes=minute), ["open", "high", "low", "close"]] = values


def intraday(candles: dict[str, Candle], day: date = DAY) -> pd.DataFrame:
    """Flat 100 one-minute bars with 15-minute candles painted in at each HH:MM key."""
    bars = minute_bars("stock", day)
    for hhmm, candle in candles.items():
        paint(bars, day, hhmm, candle)
    return bars


def daily_candles(days: list[date], candles: list[Candle]) -> pd.DataFrame:
    frame = pd.DataFrame(candles, index=pd.Index(days), columns=["open", "high", "low", "close"], dtype=float)
    return frame.assign(volume=1_000_000.0)


def make_spec(
    when: dict[str, Any],
    run_on: str = "bar_close_1m",
    session: str = "regular",
    alert: dict[str, Any] | None = None,
) -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": session, "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"], **(alert or {})}},
        }
    )


def above(value: float, op: str = "gt") -> dict[str, Any]:
    return {"op": op, "left": CLOSE, "right": {"value": value}}


def crossing(side: str, op: str) -> dict[str, Any]:
    """`close` against the running session high ("high") or low ("low") of the day."""
    return {"op": op, "left": CLOSE, "right": {"level": f"session_{side}"}}


def times(candidates) -> list[str]:
    return [c.bar_time.tz_convert("America/New_York").strftime("%m-%d %H:%M") for c in candidates]


def run(spec, bars, daily=None, as_of=None, asset="stock"):
    daily = daily if daily is not None else daily_bars([], [])
    return evaluate(spec, "TEST", asset, bars_1m=bars, bars_1d=daily, as_of=as_of or et(DAY, "20:00"))


def test_hammer_fires_on_the_15m_bar_it_completes_on():
    spec = make_spec(HAMMER_RULE, run_on="bar_close_15m")
    bars = intraday({**FALLING, "10:30": HAMMER_BAR})
    assert run(spec, bars, as_of=et(DAY, "10:44")) == []  # the 10:30 bar is still forming
    found = run(spec, bars)
    assert times(found) == ["10-06 10:30"]
    assert found[0].bar_time == pd.Timestamp("2026-10-06 14:30", tz="UTC")  # the bar's start


NEAR_MISSES = [
    pytest.param((96.2, 96.4, 95.82, 96.4), id="lower-wick-under-2x-body"),
    pytest.param((96.2, 96.6, 95.0, 96.4), id="upper-wick-over-10pct-of-range"),
    pytest.param((96.4, 96.45, 95.0, 96.41), id="body-under-10pct-of-range"),
]


@pytest.mark.parametrize("candle", NEAR_MISSES)
def test_a_candle_just_short_of_the_hammer_geometry_does_not_fire(candle):
    bars = intraday({**FALLING, "10:30": candle})
    assert run(make_spec(HAMMER_RULE, run_on="bar_close_15m"), bars) == []


@pytest.mark.parametrize(
    ("rule", "candles", "expected"),
    [
        (HAMMER_RULE, FALLING, ["10-06 10:30"]),
        (HAMMER_RULE, ZIGZAG_DOWN, ["10-06 10:30"]),
        (HAMMER_RULE, RISING, []),  # the closes before the hammer rose: no downtrend
        (HAMMER_RULE, ZIGZAG_FLAT, []),
        ({**HAMMER, "trend": "any"}, RISING, ["10-06 10:30"]),
        (HAMMER, RISING, ["10-06 10:30"]),
    ],
)
def test_the_trend_rule_reads_the_closes_before_the_candle(rule, candles, expected):
    bars = intraday({**candles, "10:30": HAMMER_BAR})
    assert times(run(make_spec(rule, run_on="bar_close_15m"), bars)) == expected


def test_pattern_evidence_holds_the_completing_candle():
    bars = intraday({**FALLING, "10:30": HAMMER_BAR})
    found = run(make_spec(HAMMER_RULE, run_on="bar_close_15m"), bars)
    assert found[0].evidence == pytest.approx(
        {
            "hammer.open": 96.2,
            "hammer.high": 96.45,
            "hammer.low": 95.0,
            "hammer.close": 96.4,
            "hammer.bodyPct": 13.793103,
            "hammer.upperWickPct": 3.448276,
            "hammer.lowerWickPct": 82.758621,
        },
        abs=1e-5,
    )


def test_within_bars_fires_once_per_edge_or_on_every_bar_with_the_same_candle():
    bars = intraday({**FALLING, "10:30": HAMMER_BAR})
    within = {**HAMMER_RULE, "withinBars": 3}
    assert times(run(make_spec(within, run_on="bar_close_15m"), bars)) == ["10-06 10:30"]
    every = run(make_spec(within, run_on="bar_close_15m", alert={"frequency": "once_per_bar"}), bars)
    assert times(every) == ["10-06 10:30", "10-06 10:45", "10-06 11:00"]
    assert all(c.evidence["hammer.open"] == 96.2 for c in every)  # the hammer, not the later bar


def test_regular_session_never_reads_pre_market_candles():
    prior_day = minute_bars("stock", trading_days("stock", DAY, 2)[0])
    pre_market = {"09:15": (101.0, 101.0, 100.0, 100.0), "09:30": solid(99.5, 101.5)}
    bars = pd.concat([prior_day, intraday(pre_market)])
    # The 09:30 engulfing covers a bearish 09:15 pre-market candle only when the session is extended.
    assert times(run(make_spec(ENGULFING, run_on="bar_close_15m", session="regular"), bars)) == []
    assert times(run(make_spec(ENGULFING, run_on="bar_close_15m", session="extended"), bars)) == ["10-06 09:30"]


def test_not_of_a_pattern_is_unknown_until_its_history_exists():
    flat = minute_bars("stock", DAY)
    # The trend rule needs 4 earlier 15-minute bars: 09:30-10:15 are unknown, so `not` cannot fire there.
    assert times(run(make_spec({"not": HAMMER_RULE}, run_on="bar_close_15m"), flat)) == ["10-06 10:30"]


def test_daily_close_reads_daily_candles_only():
    days = trading_days("stock", DAY, 3)
    daily = daily_candles(days, [solid(100.0, 100.0), solid(101.0, 100.0), solid(99.5, 101.5)])
    assert times(run(make_spec(ENGULFING, run_on="daily_close"), None, daily)) == ["10-06 16:00"]


def test_two_patterns_under_any_keep_their_own_candles():
    when = {"any": [HAMMER, ENGULFING]}
    bars = intraday({**FALLING, "10:30": HAMMER_BAR, "10:45": solid(96.4, 95.5), "11:00": solid(95.0, 97.0)})
    found = run(make_spec(when, run_on="bar_close_15m"), bars)
    assert times(found) == ["10-06 10:30", "10-06 11:00"]
    assert set(found[0].evidence) == {f"hammer.{field}" for field in CANDLE_FIELDS}
    assert set(found[1].evidence) == {f"bullish_engulfing.{field}" for field in CANDLE_FIELDS}


@pytest.mark.parametrize(("threshold", "expected"), [(97, ["10-06 10:30"]), (96, [])])
def test_a_pattern_under_all_also_needs_the_close_condition(threshold, expected):
    when = {"all": [HAMMER_RULE, above(threshold, "lt")]}
    bars = intraday({**FALLING, "10:30": HAMMER_BAR})  # the hammer closes at 96.4
    assert times(run(make_spec(when, run_on="bar_close_15m"), bars)) == expected


@pytest.mark.parametrize(
    ("side", "op", "prior", "breaking_close"),
    [("high", "crosses_above", 101.0, 101.5), ("low", "crosses_below", 99.0, 98.5)],
)
def test_a_break_of_the_running_session_extreme_fires_once(side, op, prior, breaking_close):
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", **{side: prior})  # sets the extreme; the bar's own close stays 100
    set_bar(bars, DAY, "10:30", close=breaking_close)
    found = run(make_spec(crossing(side, op)), bars)
    assert times(found) == ["10-06 10:30"]
    assert found[0].evidence == {"close": breaking_close, f"session_{side}": prior}


@pytest.mark.parametrize(("side", "op", "close"), [("high", "gt", 105.0), ("low", "lt", 95.0)])
def test_the_first_regular_bar_has_no_session_level_to_compare_with(side, op, close):
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:30", close=close)  # the level is NaN on the session's first bar
    assert run(make_spec({"op": op, "left": CLOSE, "right": {"level": f"session_{side}"}}), bars) == []


def test_session_levels_reset_each_trading_day():
    yesterday, today = trading_days("stock", DAY, 2)
    bars = pd.concat([minute_bars("stock", yesterday), minute_bars("stock", today)])
    set_bar(bars, yesterday, "10:00", high=105.0)  # yesterday's high must not carry into today
    set_bar(bars, today, "10:30", close=101.0)
    assert times(run(make_spec(crossing("high", "crosses_above")), bars)) == ["10-06 10:30"]


def test_pre_market_prints_never_set_or_break_a_session_level():
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "05:00", close=101.0)  # a pre-market-inclusive high would break here
    set_bar(bars, DAY, "08:00", high=120.0)  # ...and a pre-market-inclusive high of 120 would hide 10:30
    set_bar(bars, DAY, "10:00", high=101.0)
    set_bar(bars, DAY, "10:30", close=101.5)
    found = run(make_spec(crossing("high", "crosses_above"), session="extended"), bars)
    assert times(found) == ["10-06 10:30"]


@pytest.mark.parametrize(
    ("run_on", "reason"),
    [
        ("premarket_0830", "premarket_0830 has no closed candle at its evaluation point"),
        ("weekly", "weekly runs on daily bars, not weekly candles"),
    ],
)
def test_check_rejects_a_pattern_where_no_candle_closes(run_on, reason):
    for when in (HAMMER, {"not": HAMMER}, {"all": [above(0), {"any": [HAMMER]}]}):
        assert check(make_spec(when, run_on=run_on)) == [f"{PATTERN_REJECTED}: {reason}"]
    with pytest.raises(ValueError, match=PATTERN_REJECTED):
        run(make_spec(HAMMER, run_on=run_on), None, daily_bars([], []))


@pytest.mark.parametrize("run_on", ["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "daily_close"])
def test_check_accepts_a_pattern_on_candle_cadences_and_daily_close(run_on):
    assert check(make_spec(HAMMER_RULE, run_on=run_on)) == []


@pytest.mark.parametrize("pattern", PATTERN_IDS)
def test_every_contract_pattern_id_passes_check_at_bar_close_15m(pattern):
    assert check(make_spec({"op": "pattern", "pattern": pattern}, run_on="bar_close_15m")) == []


@pytest.mark.parametrize(
    ("side", "run_on", "problem"),
    [
        ("high", "daily_close", "session_high needs intraday bars; daily_close uses daily bars"),
        ("low", "weekly", "session_low needs intraday bars; weekly uses daily bars"),
        ("high", "premarket_0830", "session_high is not known at 08:30 ET"),
        ("low", "premarket_0830", "session_low is not known at 08:30 ET"),
        ("low", "bar_close_5m", None),
    ],
)
def test_check_session_levels_follow_the_cadence(side, run_on, problem):
    problems = check(make_spec(crossing(side, "crosses_below"), run_on=run_on))
    assert problems == ([problem] if problem else [])


def screener(when: dict[str, Any], run_on: str = "daily_close", rank: dict[str, Any] | None = None):
    spec = {
        "schemaVersion": 1,
        "name": "Screen",
        "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": run_on},
        "when": when,
        "maxResults": 10,
    }
    if rank is not None:
        spec["rank"] = rank
    return FilterStrategySpecV1.model_validate(spec)


@pytest.mark.parametrize(
    ("when", "run_on", "rank", "problems"),
    [
        (above(5), "daily_close", None, []),
        (above(5), "daily_close", {"by": {"series": "volume"}, "order": "desc"}, []),
        (
            above(5),
            "daily_close",
            {"by": {"series": "vwap"}, "order": "desc"},
            ["vwap needs intraday bars; daily_close uses daily bars"],
        ),
        (
            crossing("high", "crosses_above"),
            "daily_close",
            None,
            ["session_high needs intraday bars; daily_close uses daily bars"],
        ),
        (HAMMER, "weekly", None, [f"{PATTERN_REJECTED}: weekly runs on daily bars, not weekly candles"]),
    ],
)
def test_check_filter_checks_its_when_and_rank_like_a_strategy(when, run_on, rank, problems):
    assert check_filter(screener(when, run_on, rank)) == problems
