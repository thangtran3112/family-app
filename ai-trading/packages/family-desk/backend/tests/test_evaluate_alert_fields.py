"""`then.alert.frequency`, `expiresOn` and `message` as `evaluate()` and `check()` honour them."""

from datetime import date
from typing import Any

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import et
from ai_trading.core.evaluate import SignalCandidate, check, evaluate

DAY = date(2026, 10, 6)
DAY_BEFORE = date(2026, 10, 5)
CLOSE = {"series": "close"}
GAP_3_PERCENT = {"op": "gte", "left": {"series": "gap_pct"}, "right": {"value": 3}}


def make_spec(
    when: dict[str, Any],
    run_on: str = "bar_close_1m",
    session: str = "regular",
    alert: dict[str, Any] | None = None,
) -> StrategySpecV1:
    # A None value means the field is absent: the contract rejects an explicit null frequency.
    fields = {key: value for key, value in (alert or {}).items() if value is not None}
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": session, "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"], **fields}},
        }
    )


def above(value: float) -> dict[str, Any]:
    return {"op": "gt", "left": CLOSE, "right": {"value": value}}


def times(candidates: list[SignalCandidate]) -> list[str]:
    return [c.bar_time.tz_convert("America/New_York").strftime("%m-%d %H:%M") for c in candidates]


def run(spec, bars, daily=None, as_of=None) -> list[SignalCandidate]:
    daily = daily if daily is not None else daily_bars([], [])
    as_of = as_of if as_of is not None else et(DAY, "20:00")
    return evaluate(spec, "TEST", "stock", bars_1m=bars, bars_1d=daily, as_of=as_of)


def closes(bars: pd.DataFrame, day: date, start: str, end: str, value: float) -> None:
    for at in pd.date_range(et(day, start), et(day, end), freq="1min", inclusive="left"):
        bars.loc[at, ["open", "high", "low", "close"]] = value


def held_1m() -> pd.DataFrame:
    """Close 101 at 10:00-10:02 and at 10:04, 100 otherwise: with close > 100.5, two rising edges."""
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:00", "10:03", 101.0)
    closes(bars, DAY, "10:04", "10:05", 101.0)
    return bars


def held_15m() -> pd.DataFrame:
    """Close 101 through 10:45 (the 10:00, 10:15 and 10:30 bars hold) and 101 in the 11:00 bar,
    100 in the 10:45 bar: with close > 100.5, two rising edges."""
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:00", "10:45", 101.0)
    closes(bars, DAY, "11:00", "11:15", 101.0)
    return bars


def two_day_bars() -> pd.DataFrame:
    """Day 1 trades at 100 except 101 at 15:59; day 2 trades at 101 all day. With close > 100.5,
    rising edges at 10-05 15:59 and 10-06 09:30."""
    first_day, second_day = trading_days("stock", DAY, 2)
    first = minute_bars("stock", first_day)
    set_bar(first, first_day, "15:59", close=101.0)
    return pd.concat([first, minute_bars("stock", second_day, price=101.0)])


def premarket_gap(day: date) -> pd.DataFrame:
    """Flat 100, except 104 at 08:29: a 4% gap on a prior close of 100."""
    bars = minute_bars("stock", day)
    set_bar(bars, day, "08:29", close=104.0)
    return bars


@pytest.mark.parametrize(
    ("frequency", "expected"),
    [
        pytest.param(None, ["10-06 10:00", "10-06 10:04"], id="absent"),
        pytest.param("every_time", ["10-06 10:00", "10-06 10:04"], id="every_time"),
        pytest.param(
            "once_per_bar",
            ["10-06 10:00", "10-06 10:01", "10-06 10:02", "10-06 10:04"],
            id="once_per_bar",
        ),
        pytest.param("once", ["10-06 10:00"], id="once"),
    ],
)
def test_frequency_on_one_minute_bars(frequency, expected):
    spec = make_spec(above(100.5), alert={"frequency": frequency})
    assert times(run(spec, held_1m())) == expected


@pytest.mark.parametrize(
    ("frequency", "expected"),
    [
        pytest.param(None, ["10-06 10:00", "10-06 11:00"], id="absent"),
        pytest.param("every_time", ["10-06 10:00", "10-06 11:00"], id="every_time"),
        pytest.param(
            "once_per_bar",
            ["10-06 10:00", "10-06 10:15", "10-06 10:30", "10-06 11:00"],
            id="once_per_bar",
        ),
        pytest.param("once", ["10-06 10:00"], id="once"),
    ],
)
def test_frequency_on_fifteen_minute_bars(frequency, expected):
    spec = make_spec(above(100.5), run_on="bar_close_15m", alert={"frequency": frequency})
    assert times(run(spec, held_15m())) == expected


@pytest.mark.parametrize(
    ("frequency", "expected"),
    [
        pytest.param(None, ["09-30 16:00", "10-05 16:00"], id="absent"),
        pytest.param("every_time", ["09-30 16:00", "10-05 16:00"], id="every_time"),
        pytest.param(
            "once_per_bar",
            ["09-30 16:00", "10-01 16:00", "10-05 16:00", "10-06 16:00"],
            id="once_per_bar",
        ),
        pytest.param("once", ["09-30 16:00"], id="once"),
    ],
)
def test_frequency_on_daily_close(frequency, expected):
    days = trading_days("stock", DAY, 5)
    daily = daily_bars(days, [101.0, 101.0, 100.0, 101.0, 101.0])
    spec = make_spec(above(100.5), run_on="daily_close", alert={"frequency": frequency})
    assert times(run(spec, None, daily)) == expected


@pytest.mark.parametrize("frequency", [None, "once_per_bar"])
def test_premarket_fires_on_each_day_its_scan_is_true(frequency):
    days = trading_days("stock", DAY, 3)
    daily = daily_bars(days[:2], [100.0, 100.0])
    bars = pd.concat([premarket_gap(day) for day in days[1:]])
    spec = make_spec(GAP_3_PERCENT, run_on="premarket_0830", alert={"frequency": frequency})
    assert times(run(spec, bars, daily)) == ["10-05 08:30", "10-06 08:30"]


@pytest.mark.parametrize(
    ("frequency", "expires_on", "expected"),
    [
        pytest.param(None, "2026-10-05", ["10-05 15:59"], id="expiry-day-kept-next-day-dropped"),
        pytest.param(None, "2026-10-06", ["10-05 15:59", "10-06 09:30"], id="later-expiry-keeps-both"),
        pytest.param("once", "2026-10-05", ["10-05 15:59"], id="once-takes-first-valid"),
        pytest.param("once", "2026-10-04", [], id="once-nothing-valid"),
    ],
)
def test_expiry_is_inclusive_by_et_date(frequency, expires_on, expected):
    spec = make_spec(above(100.5), alert={"frequency": frequency, "expiresOn": expires_on})
    assert times(run(spec, two_day_bars())) == expected


@pytest.mark.parametrize("expires_on", ["2026-02-29", "2026-02-30", "2026-04-31", "2000-01-01"])
def test_expiry_that_is_not_a_real_date_or_long_past_drops_everything(expires_on):
    spec = make_spec(above(100.5), alert={"expiresOn": expires_on})
    assert run(spec, held_1m()) == []


def test_candidates_before_expiry_are_still_reported_at_a_later_as_of():
    spec = make_spec(above(100.5), alert={"expiresOn": "2026-10-05"})
    early = times(run(spec, two_day_bars(), as_of=et(DAY_BEFORE, "20:00")))
    late = times(run(spec, two_day_bars()))
    assert early == late == ["10-05 15:59"]


@pytest.mark.parametrize(
    ("template", "expected"),
    [
        ("{symbol} closed at {close} at {time}", "TEST closed at 101.00 at 10:01 ET"),
        ("{symbol}/{symbol} {close}/{close} {time}/{time}", "TEST/TEST 101.00/101.00 10:01 ET/10:01 ET"),
        ("Breakout", "Breakout"),
    ],
)
def test_message_placeholders_render_for_the_candidate_bar(template, expected):
    spec = make_spec(above(100.5), alert={"message": template})
    assert [c.message for c in run(spec, held_1m())[:1]] == [expected]


def test_time_on_fifteen_minute_bars_is_the_bar_close():
    spec = make_spec(above(100.5), run_on="bar_close_15m", alert={"message": "{time}"})
    assert [c.message for c in run(spec, held_15m())] == ["10:15 ET", "11:15 ET"]


def test_time_on_hour_bars_is_the_bar_close_of_the_open_aligned_hour():
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:30", "11:30", 101.0)  # the hour bar that starts at 10:30, not on the 10:00 hour
    spec = make_spec(above(100.5), run_on="bar_close_1h", alert={"message": "{time}"})
    assert [c.message for c in run(spec, bars)] == ["11:30 ET"]


def test_time_on_daily_close_is_the_trading_day():
    daily = daily_bars([DAY], [101.0])
    spec = make_spec(above(100.5), run_on="daily_close", alert={"message": "{symbol} {time} {close}"})
    assert [c.message for c in run(spec, None, daily)] == ["TEST 2026-10-06 101.00"]


def test_time_on_premarket_is_the_scan_time():
    daily = daily_bars(trading_days("stock", DAY, 2)[:1], [100.0])
    spec = make_spec(GAP_3_PERCENT, run_on="premarket_0830", alert={"message": "{time}"})
    assert [c.message for c in run(spec, premarket_gap(DAY), daily)] == ["08:30 ET"]


@pytest.mark.parametrize(
    ("price", "expected"),
    [(0.5, "0.5000"), (0.9999, "0.9999"), (1.0, "1.00"), (250.0, "250.00")],
)
def test_close_has_four_decimals_below_one_dollar(price, expected):
    spec = make_spec(above(0), alert={"message": "{close}"})
    assert [c.message for c in run(spec, minute_bars("stock", DAY, price=price))] == [expected]


def test_no_message_means_no_message():
    assert [c.message for c in run(make_spec(above(100.5)), held_1m())] == [None, None]


def test_message_and_frequency_leave_evidence_unchanged():
    plain = run(make_spec(above(100.5)), held_1m())
    decorated = run(
        make_spec(above(100.5), alert={"frequency": "once_per_bar", "message": "{close} {time}"}),
        held_1m(),
    )
    evidence_by_time = {c.bar_time: c.evidence for c in decorated}
    assert plain[0].evidence == {"close": 101.0}
    assert [c.evidence for c in plain] == [evidence_by_time[c.bar_time] for c in plain]


@pytest.mark.parametrize("universe", [{"symbols": ["TEST"]}, {"watchlist": "Core"}, {"filter": "Volume leaders"}])
def test_check_accepts_every_alert_field(universe):
    spec = StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": universe, "session": "regular", "runOn": "bar_close_15m"},
            "when": above(100.5),
            "then": {
                "alert": {
                    "channels": ["inbox"],
                    "frequency": "once",
                    "expiresOn": "2026-12-31",
                    "message": "{symbol} {close} {time}",
                }
            },
        }
    )
    assert check(spec) == []
