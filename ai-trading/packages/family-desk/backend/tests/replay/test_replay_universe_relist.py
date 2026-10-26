"""A day's list reads today's Desk universe, and a list built too early can be re-listed in place (D-011, D-012).

D-011: a plan saved when the universe held 17 names kept those 17 for every later day while new plans got 134. The
set is now frozen at each day's open. D-012: a plan saved at 08:30 with a 15-minute regular-hours filter can never
match, and the day screen only offered `End day`; the screen now carries a re-list offer and the server a `relist`.
Real Postgres (`scripts/test-db.sh`); the history is the synthetic world of `tests/daily_world.py`."""

import pytest
from daily_world import DAYS, SYMBOLS
from sqlalchemy import select
from test_replay_plan import _first_list, _open, _plan, _ready

from ai_trading.core.calendar import et
from ai_trading.db.models import FilterStrategy
from ai_trading.replay import plan as plan_mod
from ai_trading.replay.session import ReplayProblem

NEW = "NEWCO"  # a name the Desk universe gains after the plan was saved: it trades like FLAT


def _grow_universe(monkeypatch, world) -> list[str]:
    """The Desk universe gains NEWCO (with bars, like FLAT's)."""
    world.raw[NEW], world.split[NEW], world.minutes[NEW] = (
        world.raw["FLAT"],
        world.split["FLAT"],
        world.minutes["FLAT"],
    )
    grown = [*SYMBOLS, NEW]
    monkeypatch.setattr(plan_mod, "practice_universe", lambda db, user_id: (list(grown), False))
    return grown


# -- D-011 ---------------------------------------------------------------------------------------------------------


def test_a_plan_saved_before_a_universe_refresh_lists_the_next_day_on_the_current_universe(
    db_session, user_id, svc, world, monkeypatch
) -> None:
    plan = _ready(db_session, user_id, svc)
    day_one = _open(db_session, user_id, svc).day_list
    assert day_one.universe["size"] == 3 and plan.universe["symbols"] == SYMBOLS  # frozen when the plan was saved
    plan_mod.end_day(db_session, user_id, day_one.id, svc)
    db_session.commit()

    grown = _grow_universe(monkeypatch, world)
    waiting = _open(db_session, user_id, svc)
    assert waiting.day_list is None and waiting.restart_prep  # the new name's bars are not prepared yet
    assert waiting.plan.universe["symbols"] == grown and waiting.plan.prep["state"] == "running"
    assert waiting.plan.prep["total"] == 4

    report = plan_mod.run_prep(db_session, svc, plan.id)
    assert report["state"] == "done" and report["failed"] == {}
    day_two = _open(db_session, user_id, svc).day_list
    assert day_two.day == DAYS[1] and day_two.universe["size"] == 4 and day_two.universe["scanned"] == 4
    assert "Practice universe · 4 symbols" in day_two.universe["footnote"]
    db_session.refresh(day_one)
    assert day_one.universe["size"] == 3  # a list already built keeps what it read


def test_a_grown_universe_whose_bars_are_already_cached_builds_the_list_at_once(
    db_session, user_id, svc, world, monkeypatch
) -> None:
    plan = _ready(db_session, user_id, svc)
    day_one = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, day_one.id, svc)
    grown = _grow_universe(monkeypatch, world)
    plan.universe = {**plan.universe, "symbols": grown}  # prepare NEWCO's bars now, then fall back to the old freeze
    plan_mod.run_prep(db_session, svc, plan.id)
    plan.universe = {**plan.universe, "symbols": SYMBOLS}
    db_session.commit()

    opened = _open(db_session, user_id, svc)
    assert opened.day_list is not None and opened.day_list.universe["size"] == 4 and not opened.restart_prep
    assert opened.plan.prep["state"] == "done"


def test_an_unchanged_universe_changes_nothing_on_open(db_session, user_id, svc) -> None:
    plan = _ready(db_session, user_id, svc)
    frozen = dict(plan.universe)
    day_one = _open(db_session, user_id, svc).day_list
    plan_mod.end_day(db_session, user_id, day_one.id, svc)
    day_two = _open(db_session, user_id, svc)
    assert day_two.day_list is not None and not day_two.restart_prep
    assert day_two.plan.universe == frozen and day_two.plan.prep["state"] == "done"


# -- D-012 ---------------------------------------------------------------------------------------------------------


def _early_plan(db_session, user_id, svc):
    """A plan saved before the D-001 guard: Abnormal volume (a 15-minute regular-hours filter) listing at 08:30."""
    plan = _ready(db_session, user_id, svc)
    volume = db_session.execute(
        select(FilterStrategy.id).where(
            FilterStrategy.owner_user_id == user_id, FilterStrategy.name == "Abnormal volume"
        )
    ).scalar_one()
    plan.spec = {**plan.spec, "screen": {**plan.spec["screen"], "filters": [{"id": volume}]}}
    db_session.commit()
    return plan


def _out(db_session, user_id, svc, day_list_id):
    return plan_mod.day_list_out(db_session, user_id, day_list_id, svc)


def test_an_early_list_offers_a_relist_at_the_filters_earliest_time(db_session, user_id, svc) -> None:
    _early_plan(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    out = _out(db_session, user_id, svc, row.id)
    assert out["relist"] == {"list_at": "10:00", "label": "Re-list at 10:00 AM", "window_from": "10:00"}
    assert "none had closed by 8:30 AM" in out["warnings"][0] and "Re-list at 10:00 AM" in out["warnings"][0]


def test_an_empty_list_offers_a_relist_at_the_next_list_time(db_session, user_id, svc) -> None:
    """D-054: nothing matched and every filter could read the day, so the offer is a later look, not a dead end."""
    row = _first_list(db_session, user_id, svc)
    row.candidates = []
    db_session.commit()
    out = _out(db_session, user_id, svc, row.id)
    assert out["relist"] == {"list_at": "10:00", "label": "Re-list at 10:00 AM", "window_from": "10:00"}
    plan_mod.relist(db_session, user_id, row.id, "10:00", svc)  # the rebuilt list has names again: no more offers
    db_session.commit()
    assert _out(db_session, user_id, svc, row.id)["relist"] is None


def test_a_list_that_can_run_offers_nothing(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)  # Gap up and Gap down at 08:30: both can run
    assert _out(db_session, user_id, svc, row.id)["relist"] is None


def test_relisting_moves_the_plans_list_time_and_window_and_rebuilds_the_day_in_place(db_session, user_id, svc) -> None:
    plan = _early_plan(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    before = (row.id, row.day, row.day_no, row.created_at)
    opened = plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    db_session.commit()
    assert not opened.restart_prep and opened.day_list.id == row.id
    db_session.refresh(row)
    db_session.refresh(plan)
    assert (row.id, row.day, row.day_no, row.created_at) == before  # the same list, rebuilt
    assert row.screen["listAt"] == "10:00" and row.list_at == et(DAYS[0], "10:00")
    assert row.data_through == et(DAYS[0], "09:45") and row.status == "listed"
    assert plan.spec["screen"]["listAt"] == "10:00" and plan.spec["setup"]["window"] == {"from": "10:00", "to": "11:30"}
    out = _out(db_session, user_id, svc, row.id)
    assert "none had closed" not in " ".join(out["warnings"])  # the reason is gone
    # D-054: nothing matched at 10:00 either, so the next offer is the later list time, not a dead end
    assert out["relist"] == {"list_at": "10:45", "label": "Re-list at 10:45 AM", "window_from": "10:45"}
    assert out["screen"]["list_at"] == "10:00"


def test_relisting_keeps_the_stars_that_are_still_on_the_list(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)  # Gap up and Gap down: GAPPER is on the 08:30 list and the 10:00 one
    plan_mod.patch_day_list(
        db_session, user_id, row.id, svc, watch=["GAPPER"], notes=None, rating=None, fields={"watch"}
    )
    plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    db_session.refresh(row)
    assert [c["symbol"] for c in row.candidates] == ["GAPPER"] and [w["symbol"] for w in row.watch] == ["GAPPER"]


@pytest.mark.parametrize(
    ("list_at", "message"),
    [
        ("09:00", "Abnormal volume needs a list time of 10:00 AM or later"),
        ("04:00", "Abnormal volume needs a list time of 10:00 AM or later"),
    ],
)
def test_relisting_applies_the_new_plan_rules(db_session, user_id, svc, list_at, message) -> None:
    _early_plan(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.relist(db_session, user_id, row.id, list_at, svc)
    assert caught.value.path == "listAt" and caught.value.message.startswith(message)
    assert caught.value.status == 422


def test_a_relist_that_would_close_the_window_is_refused(db_session, user_id, svc) -> None:
    plan = _early_plan(db_session, user_id, svc)
    plan.spec = {**plan.spec, "setup": {**plan.spec["setup"], "window": {"from": "09:30", "to": "10:00"}}}
    db_session.commit()
    row = _open(db_session, user_id, svc).day_list
    assert _out(db_session, user_id, svc, row.id)["relist"] is None  # nothing to offer: the window ends at 10:00
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    assert (caught.value.path, caught.value.message) == ("listAt", "window.from must be before window.to")
    db_session.refresh(plan)
    assert plan.spec["screen"]["listAt"] == "08:30"  # a refused relist changes nothing


def test_a_day_under_way_or_on_a_replaced_plan_cannot_be_relisted(db_session, user_id, svc) -> None:
    row = _first_list(db_session, user_id, svc)
    plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    with pytest.raises(ReplayProblem) as under_way:
        plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    assert under_way.value.status == 409 and "under way" in under_way.value.message

    plan_mod.end_day(db_session, user_id, row.id, svc)
    _plan(db_session, user_id, svc)  # a newer plan archives the old one
    with pytest.raises(ReplayProblem) as replaced:
        plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    assert replaced.value.status == 409 and "replaced" in replaced.value.message


def test_relisting_on_a_grown_universe_saves_the_plan_then_waits_for_the_new_bars(
    db_session, user_id, svc, world, monkeypatch
) -> None:
    plan = _early_plan(db_session, user_id, svc)
    row = _open(db_session, user_id, svc).day_list
    _grow_universe(monkeypatch, world)
    first = plan_mod.relist(db_session, user_id, row.id, "10:00", svc)
    db_session.commit()
    assert first.restart_prep and first.plan.spec["screen"]["listAt"] == "10:00"
    db_session.refresh(row)
    assert row.screen["listAt"] == "08:30"  # the list waits for the data; the offer stays on screen
    assert _out(db_session, user_id, svc, row.id)["relist"] is not None

    plan_mod.run_prep(db_session, svc, plan.id)
    second = plan_mod.relist(db_session, user_id, row.id, "10:00", svc)  # relisting again finishes it
    db_session.commit()
    assert not second.restart_prep
    db_session.refresh(row)
    assert row.screen["listAt"] == "10:00" and row.universe["size"] == 4
