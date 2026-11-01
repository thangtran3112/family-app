"""Re-scan at the playhead (02o-b2, `plan.start_rescan` + `plan.run_rescan`): the day's filters run again at the day
clock in a background job that reports progress, and the finished scan REPOPULATES the day list (it replaces the list's
names, never appends a second one), labelled with the clock it ran at. Real Postgres; the synthetic world of
`tests/daily_world.py`.

The world: GAPPER sits at 106 in the premarket and 110 from the open (the "Gap up" filter evaluates on the premarket
close and keeps it on the list); FLAT sits at 50 all day and SPLITTER splits after the third day, so neither matches a
gap filter on the first morning."""

import copy
from datetime import timedelta

import pandas as pd
import pytest
from daily_world import DAYS, NOW, SYMBOLS, make_services
from sqlalchemy import select
from test_replay_plan import _advance, _filter_id, _first_list

from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy, FilterStrategyVersion, ReplayDayList, ReplayDayScan
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import screen
from ai_trading.replay.session import ReplayProblem, SessionNotFound


def _practising(db_session, user_id, svc):
    """The first list with GAPPER practised from the open (the day clock at 09:30)."""
    row = _first_list(db_session, user_id, svc)
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    db_session.commit()
    return row, started


def _scan(db_session, user_id, row, svc) -> ReplayDayScan | None:
    """A whole re-scan as the API runs it: mark the job, commit, then the background half."""
    run = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    return None if run is None else plan_mod.run_rescan(db_session, svc, row.id, run)


def _scans(db_session, row) -> list[ReplayDayScan]:
    return list(
        db_session.execute(
            select(ReplayDayScan).where(ReplayDayScan.day_list_id == row.id).order_by(ReplayDayScan.seq)
        ).scalars()
    )


def _symbols(row) -> list[str]:
    return [c["symbol"] for c in row.candidates]


def test_a_rescan_runs_at_the_day_clock_and_says_what_it_saw_and_when(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    scan = _scan(db_session, user_id, row, svc)
    assert scan is not None and scan.seq == 1 and scan.as_of == et(DAYS[0], "10:00")
    assert scan.data_through == et(DAYS[0], "10:00") - screen.LIST_DATA_LAG  # the same 15-minute embargo as the list
    # "Gap up" runs once, on the premarket close: its evaluation price is that bar's close, 106, however late the clock.
    assert [(c["symbol"], c["list_price"], c["new_since_list"]) for c in scan.candidates] == [("GAPPER", 106.0, False)]
    assert scan.universe["prev_basis"] is False  # regular bars exist at the cut: the metric columns are today's
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["rescan"] == {
        "seq": 1,
        "as_of": et(DAYS[0], "10:00"),
        "data_through": scan.data_through,
        "new_count": 0,
        "created_at": NOW,
    }
    assert out["universe"]["scanned"] == 3 and out["columns"][0]["key"] == "list_price"


def test_a_rescan_repopulates_the_list_with_the_scans_names_columns_counts_and_data_cut(
    db_session, user_id, svc
) -> None:
    row, started = _practising(db_session, user_id, svc)
    before = copy.deepcopy((row.universe, row.data_through, row.list_at, row.screen))
    _advance(db_session, user_id, svc, started.id, "10:30")
    db_session.commit()
    scan = _scan(db_session, user_id, row, svc)
    db_session.refresh(row)
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    # The one list on the page is now the scan's: its names, its columns, its counts, its data cut.
    assert out["candidates"] == scan.candidates and out["columns"] == scan.columns
    assert out["universe"] == scan.universe and out["data_through"] == scan.data_through != before[1]
    # What the plan decided stays: the list time, the screen and the recorded universe line.
    assert (row.list_at, row.screen) == (before[2], before[3])
    assert (
        out["universe"]["footnote"] == before[0]["footnote"]
        and out["universe"]["membership"] == before[0]["membership"]
    )


def test_a_second_rescan_replaces_the_list_it_does_not_append_another(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "09:45")
    db_session.commit()
    _scan(db_session, user_id, row, svc)
    db_session.refresh(row)
    first_list = copy.deepcopy(row.candidates)
    _advance(db_session, user_id, svc, started.id, "10:15")
    db_session.commit()
    second = _scan(db_session, user_id, row, svc)
    db_session.refresh(row)
    assert second is not None and second.seq == 2 and second.as_of == et(DAYS[0], "10:15")
    # One entry per name, however many scans ran: the list was replaced, so nothing was added beside it.
    assert _symbols(row) == ["GAPPER"] == [c["symbol"] for c in first_list]
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert out["rescan"]["seq"] == 2 and out["rescan_job"]["state"] == "done"
    assert [s.seq for s in _scans(db_session, row)] == [1, 2]  # each scan stays on record, labelled with its clock
    assert [s.as_of for s in _scans(db_session, row)] == [et(DAYS[0], "09:45"), et(DAYS[0], "10:15")]


def test_a_name_the_list_did_not_hold_joins_it_marked_new_and_can_then_be_starred_and_practised(
    db_session, user_id, svc
) -> None:
    row, started = _practising(db_session, user_id, svc)
    row.candidates = []  # the list as it would have been had GAPPER not matched at 08:15
    db_session.commit()
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    _scan(db_session, user_id, row, svc)
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert [(c["symbol"], c["new_since_list"], c["held_over"]) for c in out["candidates"]] == [("GAPPER", True, False)]
    assert out["rescan"]["new_count"] == 1
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    assert plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc).day_list_id == row.id
    # A name that was on the list before is not new to the next scan.
    _advance(db_session, user_id, svc, started.id, "10:30")
    db_session.commit()
    _scan(db_session, user_id, row, svc)
    assert [c["new_since_list"] for c in plan_mod.day_list_out(db_session, user_id, row.id, svc)["candidates"]] == [
        False
    ]


def test_a_name_she_opened_or_starred_stays_when_the_scan_no_longer_matches_it(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    gapper = copy.deepcopy(row.candidates[0])
    # The morning list held three more names; the scan (flat all day, or split) matches none of them.
    extra = [{**gapper, "symbol": name, "rank": rank} for rank, name in enumerate(["FLAT", "SPLITTER", "PHANTOM"], 2)]
    row.candidates = [gapper, *extra]
    db_session.commit()
    plan_mod.patch_day_list(db_session, user_id, row.id, svc, watch=["FLAT"], notes=None, rating=None, fields={"watch"})
    plan_mod.start_session(db_session, user_id, row.id, "SPLITTER", svc)  # opened, not starred
    db_session.commit()
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    _scan(db_session, user_id, row, svc)
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    # GAPPER matches. FLAT (starred) and SPLITTER (opened) stay, marked and ranked after the scan's names. PHANTOM was
    # neither, so it leaves with the rest of the morning list.
    assert [(c["symbol"], c["rank"], c["held_over"]) for c in out["candidates"]] == [
        ("GAPPER", 1, False),
        ("FLAT", 2, True),
        ("SPLITTER", 3, True),
    ]
    assert [w["symbol"] for w in out["watch"]] == ["FLAT"]  # the star stands
    assert out["universe"]["shown"] == 1  # the scan's own count excludes the names she kept
    # Both can still be starred and opened again: they are on the list.
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["FLAT", "SPLITTER"], notes=None, rating=None, fields={"watch"}
    )
    assert plan_mod.start_session(db_session, user_id, row.id, "SPLITTER", svc).symbol == "SPLITTER"


def test_a_second_rescan_at_the_same_clock_starts_nothing(db_session, user_id, svc) -> None:
    row, started = _practising(db_session, user_id, svc)
    first = _scan(db_session, user_id, row, svc)  # the clock is at the open, 09:30
    assert first is not None and first.seq == 1 and first.as_of == et(DAYS[0], "09:30")
    job = copy.deepcopy(db_session.get(ReplayDayList, row.id).rescan_job)
    assert plan_mod.start_rescan(db_session, user_id, row.id, svc) is None
    assert len(_scans(db_session, row)) == 1 and db_session.get(ReplayDayList, row.id).rescan_job == job
    _advance(db_session, user_id, svc, started.id, "09:45")
    db_session.commit()
    later = _scan(db_session, user_id, row, svc)
    assert later is not None and later.seq == 2 and later.as_of == et(DAYS[0], "09:45")


def test_a_rescan_needs_a_day_clock_and_a_day_that_is_not_over(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    with pytest.raises(ReplayProblem) as early:
        plan_mod.start_rescan(db_session, user_id, row.id, svc)
    assert early.value.status == 409 and early.value.message.startswith("Practice a name first")
    plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    assert _scan(db_session, user_id, row, svc) is not None
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    with pytest.raises(ReplayProblem) as late:
        plan_mod.start_rescan(db_session, user_id, row.id, svc)
    assert late.value.status == 409 and late.value.message == "The day is over · scans are closed"
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan"]["seq"] == 1  # history stays readable


def test_a_clock_before_the_list_time_has_nothing_new_to_scan(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    row.revealed_through = et(DAYS[0], "08:00").to_pydatetime()
    db_session.commit()
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.start_rescan(db_session, user_id, row.id, svc)
    assert caught.value.message == "The day clock is before your 8:30 AM list time · nothing new to scan yet"


def test_a_stranger_cannot_scan_a_day_that_is_not_theirs(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    with pytest.raises(SessionNotFound):
        plan_mod.start_rescan(db_session, user_id + 1, row.id, svc)


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
    scan = _scan(db_session, user_id, row, svc)
    assert scan is not None and [c["symbol"] for c in scan.candidates] == ["GAPPER"]
    used = {item["version_id"] for item in scan.universe["filters"]}
    assert used == {item["version_id"] for item in row.screen["filters"]} and newest.id not in used


def test_a_rescan_reads_nothing_after_its_own_cut(db_session, user_id, svc, world) -> None:
    """Every minute bar after `clock - 15m` is replaced in a second world; the scan must not notice."""
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    honest = _scan(db_session, user_id, row, svc)
    assert honest is not None
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
    corrupted = _scan(db_session, user_id, row, make_services(world))
    assert corrupted is not None
    assert (corrupted.candidates, corrupted.columns, corrupted.universe["filters"]) == honest_view


# -- progress: the job the screen polls ------------------------------------------------------------------------------


def test_a_rescan_is_running_the_moment_it_starts_and_reports_each_symbol_it_reads(
    db_session, user_id, svc, monkeypatch
) -> None:
    row, started = _practising(db_session, user_id, svc)
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    run = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    running = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan_job"]
    assert running == {
        "state": "running",
        "as_of": et(DAYS[0], "10:00").isoformat(),
        "done": 0,
        "total": 0,
        "message": None,
    }

    monkeypatch.setattr(plan_mod, "RESCAN_TICK_S", 0.0)  # report every symbol, not at most every 0.4 s
    seen: list[tuple[int, int]] = []
    real = plan_mod._Progress.write

    def spy(self, *, force: bool = False) -> None:
        real(self, force=force)
        job = db_session.get(ReplayDayList, row.id).rescan_job
        seen.append((job["done"], job["total"]))

    monkeypatch.setattr(plan_mod._Progress, "write", spy)
    assert run is not None and plan_mod.run_rescan(db_session, svc, row.id, run) is not None
    done = [d for d, _ in seen]
    assert seen[0] == (0, len(SYMBOLS)) and done == sorted(done)  # counted up, never back
    assert (len(SYMBOLS), len(SYMBOLS)) in seen  # every symbol was read before the list was built
    finished = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan_job"]
    assert finished["state"] == "done" and (finished["done"], finished["total"]) == (len(SYMBOLS), len(SYMBOLS))


def test_a_second_request_joins_a_scan_that_is_running_and_starts_no_other(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    run = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    token = db_session.get(ReplayDayList, row.id).rescan_job["run"]
    assert run == token
    assert plan_mod.start_rescan(db_session, user_id, row.id, svc) is None  # joined
    assert db_session.get(ReplayDayList, row.id).rescan_job["run"] == token


def test_a_scan_whose_worker_died_reads_as_failed_and_the_next_request_takes_it_over(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    dead = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    stale = db_session.get(ReplayDayList, row.id)
    stale.rescan_job = {
        **stale.rescan_job,
        "updated_at": (NOW - plan_mod.RESCAN_STALE - timedelta(seconds=1)).isoformat(),
    }
    db_session.commit()
    job = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan_job"]
    assert job["state"] == "failed" and job["message"] == plan_mod.RESCAN_DIED
    taken = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    assert taken is not None and taken != dead
    # The old worker wakes up late: it finds another token on the job and writes nothing.
    assert plan_mod.run_rescan(db_session, svc, row.id, dead) is None
    assert _scans(db_session, row) == [] and db_session.get(ReplayDayList, row.id).rescan_job["run"] == taken
    assert plan_mod.run_rescan(db_session, svc, row.id, taken) is not None


def test_a_scan_that_breaks_closes_its_job_as_failed_and_leaves_the_list_as_it_was(
    db_session, user_id, svc, monkeypatch
) -> None:
    row, _ = _practising(db_session, user_id, svc)
    before = copy.deepcopy((row.candidates, row.columns, row.universe, row.data_through))

    def broken(**_kwargs):
        raise RuntimeError("the bar source fell over")

    monkeypatch.setattr(plan_mod, "build_list", broken)
    assert _scan(db_session, user_id, row, svc) is None
    db_session.refresh(row)
    job = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan_job"]
    assert job["state"] == "failed" and job["message"] == "Couldn't finish the re-scan · try again"
    assert (row.candidates, row.columns, row.universe, row.data_through) == before and _scans(db_session, row) == []
    monkeypatch.undo()
    assert _scan(db_session, user_id, row, svc) is not None  # a failed scan can be run again


def test_a_day_that_ends_while_the_scan_reads_is_not_repopulated(db_session, user_id, svc) -> None:
    row, _ = _practising(db_session, user_id, svc)
    run = plan_mod.start_rescan(db_session, user_id, row.id, svc)
    db_session.commit()
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    before = copy.deepcopy(row.candidates)
    assert run is not None and plan_mod.run_rescan(db_session, svc, row.id, run) is None
    db_session.refresh(row)
    assert row.candidates == before and _scans(db_session, row) == []
    job = plan_mod.day_list_out(db_session, user_id, row.id, svc)["rescan_job"]
    assert job["state"] == "failed" and job["message"] == "The day ended before the re-scan finished"
