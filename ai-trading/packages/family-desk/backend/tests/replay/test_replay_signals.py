"""Strategy on replay (02o §i): the engine-equivalence (prefix consistency) property and the wrapper rules.

Releasing one full-window `core.evaluate.evaluate` run by the playhead is only safe if the engine is prefix-
consistent: the candidates of `evaluate(as_of=t)` must equal the full run's candidates whose bar close is at or
before `t`. A property test over the fixture day pins it for the seed templates and for the `once`,
`once_per_bar` and `every_time` frequencies (every 15th minute plus the minutes around each full-run fire)."""

import copy
from datetime import date

import pandas as pd
import pytest

from ai_trading.core.calendar import et
from ai_trading.library.catalog import alert_only_spec, load_catalog, load_template
from ai_trading.replay import signals as S

DAY = date(2026, 9, 25)
OPEN, CLOSE = et(DAY, "09:30"), et(DAY, "16:00")


def seed(entry_id: str, **alert) -> S.Armed:
    entry = next(e for e in load_catalog().entries if e.id == entry_id)
    spec = alert_only_spec(load_template(entry.file), name=entry.label).model_dump(
        mode="json", by_alias=True, exclude_none=True
    )
    spec["then"]["alert"].update(alert)
    return S.Armed("alert_strategy", 1, 1, entry.label, entry.bias, spec)


def run(armed: list[S.Armed], inputs, end: pd.Timestamp = CLOSE) -> list[S.Fire]:
    return S.evaluate_window(
        armed, "TSLA", DAY, bars_1m=inputs.bars_1m, daily=inputs.daily, window_start=OPEN, window_end=end
    )


def key(fires: list[S.Fire]) -> list[tuple]:
    return [(f.name, f.bar_time, f.bar_close) for f in fires]


ARMED = [
    seed("vwap-reclaim", frequency="every_time"),
    seed("vwap-loss", frequency="once_per_bar"),
    seed("inside-bar", frequency="once"),
    seed("orb-breakout"),
]


def test_the_fixture_day_has_fires_to_check(inputs) -> None:
    fires = run(ARMED, inputs)
    assert {f.name for f in fires} >= {"VWAP reclaim", "VWAP loss", "Inside bar"}
    assert [f for f in fires if f.name == "Inside bar"] == [f for f in fires if f.name == "Inside bar"][:1]  # once
    assert all(OPEN < f.bar_close <= CLOSE for f in fires)
    assert key(fires) == sorted(key(fires), key=lambda k: (k[2], k[0]))


def test_prefix_consistency_across_the_day(inputs) -> None:
    full = run(ARMED, inputs)
    minutes = {OPEN + pd.Timedelta(minutes=m) for m in range(1, 391, 15)}
    for fire in full[:14]:
        minutes |= {fire.bar_close - pd.Timedelta(minutes=1), fire.bar_close, fire.bar_close + pd.Timedelta(minutes=1)}
    for t in sorted(m for m in minutes if OPEN < m <= CLOSE):
        part = run(ARMED, inputs, t)
        expected = [f for f in full if f.bar_close <= t]
        assert key(part) == key(expected), f"prefix at {t} differs from the full run"
        assert [round(f.close, 4) for f in part] == [round(f.close, 4) for f in expected]


def test_a_fire_is_released_exactly_when_its_bar_closes() -> None:
    fire = S.Fire("alert_strategy", 1, "x", None, et(DAY, "10:00"), et(DAY, "10:01"), 1.0)
    assert S.released([fire], et(DAY, "10:00")) == []
    assert S.released([fire], et(DAY, "10:01")) == [fire]
    assert S.next_after([fire], et(DAY, "10:00")) == fire and S.next_after([fire], et(DAY, "10:01")) is None


def test_expires_on_in_the_past_is_ignored_in_replay(inputs) -> None:
    live = seed("vwap-reclaim", frequency="every_time")
    dead = copy.deepcopy(live)
    dead.spec["then"]["alert"]["expiresOn"] = "2020-01-01"
    assert len(run([dead], inputs)) == len(run([live], inputs)) > 0


def test_once_is_applied_inside_the_window_not_over_the_lookback(inputs) -> None:
    every = run([seed("vwap-reclaim", frequency="every_time")], inputs)
    once = run([seed("vwap-reclaim", frequency="once")], inputs)
    assert key(once) == key(every)[:1]


def test_no_cooldown_in_replay(inputs) -> None:
    """The template says cooldownMinutes 30; replay lists every rising edge (02o decision 4)."""
    armed = seed("vwap-reclaim", frequency="every_time")
    assert armed.spec["limits"]["cooldownMinutes"] == 30
    fires = run([armed], inputs)
    gaps = [(b.bar_close - a.bar_close) for a, b in zip(fires, fires[1:], strict=False)]
    assert any(gap < pd.Timedelta(minutes=30) for gap in gaps)


def test_a_daily_close_strategy_fires_at_the_close_only(inputs) -> None:
    spec = seed("vwap-reclaim", frequency="once_per_bar").spec  # the rule is true every day: no rising edge today
    spec["watch"]["runOn"] = "daily_close"
    spec["when"] = {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}}
    armed = [S.Armed("alert_strategy", 2, 2, "Daily", None, spec)]
    at_close = run(armed, inputs, CLOSE)
    assert [f.bar_close for f in at_close] == [CLOSE]
    assert run(armed, inputs, CLOSE - pd.Timedelta(minutes=1)) == []


def test_fires_round_trip_through_the_session_row(inputs) -> None:
    fires = run(ARMED, inputs)
    assert S.load_fires(S.dump_fires(fires)) == fires


def test_the_mvp_stub_world_strategies_arm_by_id(db_session, monkeypatch) -> None:
    """With DESK_MVP_STUB=1 the strategies she sees live in the fixture world, not the database."""
    from ai_trading.mvp_stub import STUB_FLAG, world

    monkeypatch.setenv(STUB_FLAG, "1")
    strategy = world.alert_strategies()[0]
    filter_row = world.filters()[0]
    armed = S.resolve(
        db_session,
        1,
        [{"source": "alert_strategy", "id": strategy["id"]}, {"source": "filter", "id": filter_row["id"]}],
        "TSLA",
    )
    assert [a.name for a in armed] == [strategy["spec"]["name"], filter_row["name"]]
    monkeypatch.delenv(STUB_FLAG)
    with pytest.raises(S.ArmProblem):
        S.resolve(db_session, 1, [{"source": "alert_strategy", "id": strategy["id"]}], "TSLA")
