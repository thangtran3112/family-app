"""Re-scan at the playhead (02o-b2, `plan.rescan`): the day's filters run again at the day clock, labelled with that
clock, without ever touching the frozen list. Real Postgres; the synthetic world of `tests/daily_world.py`.

The world: GAPPER sits at 106 in the premarket and 110 from the open (the "Gap up" filter evaluates on the premarket
close and keeps it on the list); FLAT sits at 50 all day and SPLITTER splits after the third day, so neither matches a
gap filter on the first morning."""

import copy

import pandas as pd
import pytest
from daily_world import DAYS, NOW, SYMBOLS, make_services
from sqlalchemy import select
from test_replay_plan import _advance, _filter_id, _first_list

from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy, FilterStrategyVersion, ReplayDayScan
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import screen
from ai_trading.replay.session import ReplayProblem, SessionNotFound


def _practising(db_session, user_id, svc):
    """The first list with GAPPER practised from the open (the day clock at 09:30)."""
    row = _first_list(db_session, user_id, svc)
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    db_session.commit()
    return row, started


def _scans(db_session, row) -> list[ReplayDayScan]:
    return list(
        db_session.execute(
            select(ReplayDayScan).where(ReplayDayScan.day_list_id == row.id).order_by(ReplayDayScan.seq)
        ).scalars()
    )


def test_a_rescan_runs_at_the_day_clock_and_says_what_it_saw_and_when(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    scan = plan_mod.rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    assert scan.seq == 1 and scan.as_of == et(DAYS[0], "10:00")
    assert scan.data_through == et(DAYS[0], "10:00") - screen.LIST_DATA_LAG  # the same 15-minute embargo as the list
    # "Gap up" runs once, on the premarket close: its evaluation price is that bar's close, 106, however late the clock.
    assert [(c["symbol"], c["list_price"], c["new_since_list"]) for c in scan.candidates] == [("GAPPER", 106.0, False)]
    assert scan.universe["prev_basis"] is False  # regular bars exist at the cut: the metric columns are today's
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan"]
    assert (out["seq"], out["as_of"], out["new_count"]) == (1, et(DAYS[0], "10:00"), 0)
    assert out["universe"]["scanned"] == 3 and out["columns"][0]["key"] == "list_price"


def test_a_rescan_never_touches_the_frozen_list_its_stars_or_its_universe_line(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    db_session.commit()
    before = copy.deepcopy((row.candidates, row.universe, row.columns, row.watch, row.data_through, row.list_at))
    _advance(db_session, user_id, svc, started.id, "10:30")
    db_session.commit()
    plan_mod.rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    db_session.refresh(row)
    assert (row.candidates, row.universe, row.columns, row.watch, row.data_through, row.list_at) == before
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["data_through"] == before[4] and out["rescan"]["data_through"] != before[4]
    # The scan states the same universe in the same words (the recorded morning, or today's set).
    assert out["rescan"]["universe"]["footnote"] == out["universe"]["footnote"]
    assert out["rescan"]["universe"]["membership"] == out["universe"]["membership"]


def test_a_name_the_list_did_not_hold_is_marked_new_and_cannot_be_starred_or_practised(
    db_session, user_id, svc
) -> None:
    row, started = _practising(db_session, user_id, svc)
    row.candidates = []  # the list as it would have been had GAPPER not matched at 08:15
    db_session.commit()
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    plan_mod.rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["candidates"] == []  # the frozen list is still what it was
    assert [(c["symbol"], c["new_since_list"]) for c in out["rescan"]["candidates"]] == [("GAPPER", True)]
    assert out["rescan"]["new_count"] == 1
    with pytest.raises(ReplayProblem) as starred:
        plan_mod.patch_day_list(
            db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
        )
    assert starred.value.message == "GAPPER is not on today's list"
    with pytest.raises(ReplayProblem) as practised:
        plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert practised.value.message == "GAPPER is not on today's list"


def test_a_second_rescan_at_the_same_clock_is_the_first_and_a_later_clock_is_a_new_scan(
    db_session, user_id, svc
) -> None:
    row, started = _practising(db_session, user_id, svc)
    first = plan_mod.rescan(db_session, user_id, row.id, svc)  # the clock is at the open, 09:30
    db_session.commit()
    assert first.seq == 1 and first.as_of == et(DAYS[0], "09:30")
    again = plan_mod.rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    assert again.id == first.id and len(_scans(db_session, row)) == 1
    _advance(db_session, user_id, svc, started.id, "09:45")
    db_session.commit()
    later = plan_mod.rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    assert later.seq == 2 and later.as_of == et(DAYS[0], "09:45")
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["rescan"]["seq"] == 2 and [s.seq for s in _scans(db_session, row)] == [1, 2]  # the first stays on record


def test_a_rescan_needs_a_day_clock_and_a_day_that_is_not_over(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    with pytest.raises(ReplayProblem) as early:
        plan_mod.rescan(db_session, user_id, row.id, svc)
    assert early.value.status == 409 and early.value.message.startswith("Practice a name first")
    plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    plan_mod.rescan(db_session, user_id, row.id, svc)
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    with pytest.raises(ReplayProblem) as late:
        plan_mod.rescan(db_session, user_id, row.id, svc)
    assert late.value.status == 409 and late.value.message == "The day is over · scans are closed"
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan"]["seq"] == 1  # history stays readable


def test_a_clock_before_the_list_time_has_nothing_new_to_scan(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    row.revealed_through = et(DAYS[0], "08:00").to_pydatetime()
    db_session.commit()
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.rescan(db_session, user_id, row.id, svc)
    assert caught.value.message == "The day clock is before your 8:30 AM list time · nothing new to scan yet"


def test_a_stranger_cannot_scan_a_day_that_is_not_theirs(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    with pytest.raises(SessionNotFound):
        plan_mod.rescan(db_session, user_id + 1, row.id, svc)


def test_a_rescan_uses_the_filter_versions_the_list_used_not_the_ones_she_has_since_saved(
    db_session, user_id, svc
) -> None:
    row, _ = _practising(db_session, user_id, svc)
    gap_up = db_session.get(FilterStrategy, _filter_id(db_session, user_id, "Gap up"))
    gap_down = db_session.get(FilterStrategy, _filter_id(db_session, user_id, "Gap down"))
    never = db_session.get(FilterStrategyVersion, gap_down.current_version_id)
    newest = FilterStrategyVersion(
        filter_strategy_id=gap_up.id,
        version=99,
        schema_version=never.schema_version,
        spec=never.spec,  # a filter that does not match GAPPER on this morning
        created_by=user_id,
        created_at=NOW,
    )
    db_session.add(newest)
    db_session.flush()
    gap_up.current_version_id = newest.id
    db_session.commit()
    scan = plan_mod.rescan(db_session, user_id, row.id, svc)
    assert [c["symbol"] for c in scan.candidates] == ["GAPPER"]
    used = {item["version_id"] for item in scan.universe["filters"]}
    assert used == {item["version_id"] for item in row.screen["filters"]} and newest.id not in used


def test_a_rescan_reads_nothing_after_its_own_cut(db_session, user_id, svc, world) -> None:
    """Every minute bar after `clock - 15m` is replaced in a second world; the scan must not notice."""
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    honest = plan_mod.rescan(db_session, user_id, row.id, svc)
    honest_view = (copy.deepcopy(honest.candidates), copy.deepcopy(honest.columns), honest.universe["filters"])
    db_session.delete(honest)
    db_session.commit()

    through = et(DAYS[0], "10:00") - screen.LIST_DATA_LAG
    for symbol in SYMBOLS:
        frame = world.minutes[symbol].copy()
        future = frame.index + pd.Timedelta(minutes=1) > through
        frame.loc[future, ["open", "high", "low", "close"]] = 777.0
        frame.loc[future, "volume"] = 99_999_999.0
        world.minutes[symbol] = frame
    corrupted = plan_mod.rescan(db_session, user_id, row.id, make_services(world))
    assert (corrupted.candidates, corrupted.columns, corrupted.universe["filters"]) == honest_view
