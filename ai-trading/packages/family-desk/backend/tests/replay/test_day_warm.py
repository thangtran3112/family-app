"""Warming a day (A7): opening a day with 49 names prepares every name's series from the blob cache, so after the prep a
read of the day (the chart, the live day list) asks the provider for nothing and decodes no blob. Real Postgres; the
synthetic world of `tests/daily_world.py` with 46 more names that trade like FLAT."""

import pandas as pd
from daily_world import SYMBOLS, make_thread
from test_day_positions import _extra_names
from test_replay_plan import _plan

from ai_trading.core.calendar import et
from ai_trading.replay import data as data_mod
from ai_trading.replay import frames
from ai_trading.replay import plan as plan_mod

NAMES = [f"N{i}" for i in range(46)]


def _day_of_49(db_session, user_id, svc, world):
    """A prepared first day whose list holds 49 names (the three synthetic ones and 46 more)."""
    _extra_names(world, *NAMES)
    make_thread(db_session, user_id)
    plan = _plan(db_session, user_id, svc)
    plan.universe = {**plan.universe, "symbols": [*SYMBOLS, *NAMES]}
    plan.prep = {**plan.prep, "total": len(SYMBOLS) + len(NAMES)}
    db_session.commit()
    plan_mod.run_prep(db_session, svc, plan.id)
    row = plan_mod.open_next(db_session, user_id, svc).day_list
    first = row.candidates[0]
    row.candidates = [{**first, "symbol": symbol, "rank": rank} for rank, symbol in enumerate([*SYMBOLS, *NAMES], 1)]
    db_session.commit()
    assert len(row.candidates) == 49
    return row


def test_the_caches_hold_a_whole_49_name_day() -> None:
    assert data_mod.LRU_DAYS == 64 and frames.LRU_SERIES == 128  # one full day of 49 names fits in each


def test_warming_a_49_name_day_asks_the_provider_for_nothing_and_a_live_read_then_decodes_nothing(
    db_session, user_id, svc, world
) -> None:
    row = _day_of_49(db_session, user_id, svc, world)
    fetches = svc.history.fetches
    assert plan_mod.warm_day(db_session, svc, row.id) == 49
    assert svc.history.fetches == fetches, "a warm decodes blobs; it never asks the provider"
    assert len(svc.history.series) >= 49

    store = svc.store_factory(db_session)
    reads: list[str] = []
    real = store.get

    def counting(key):
        reads.append(key.kind)
        return real(key)

    store.get = counting  # type: ignore[method-assign]
    clock = pd.Timestamp(et(row.day, "10:15"))
    row.revealed_through = clock.to_pydatetime()
    for _ in range(3):  # the screen re-reads the whole list every clock minute
        out = plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
        assert len(out["candidates"]) == 49 and all(c["live"] is not None for c in out["candidates"])
    assert svc.history.fetches == fetches, "a 49-name live read must not grow History.fetches"
    assert reads == [], f"a warm day decodes no blob on a read: {reads[:5]}"


def test_a_warm_of_an_unknown_name_or_a_missing_day_is_skipped_not_fatal(db_session, user_id, svc, world) -> None:
    row = _day_of_49(db_session, user_id, svc, world)
    store = svc.store_factory(db_session)
    done = frames.warm(svc.history, store, ["NOPE", "FLAT"], row.day, 5)  # NOPE has no bars at all
    assert done == 1


def test_the_metric_row_is_computed_once_per_closed_minute_and_name(
    db_session, user_id, svc, world, monkeypatch
) -> None:
    """The dearest part of a live read (about 55 ms a name) is a pure function of the cut: reads inside one clock minute
    share it, and the next minute computes it again."""
    from ai_trading.replay import screen

    row = _day_of_49(db_session, user_id, svc, world)
    plan_mod.warm_day(db_session, svc, row.id)
    calls = []
    real = screen.metric_row
    monkeypatch.setattr(screen, "metric_row", lambda *args: calls.append(1) or real(*args))
    row.revealed_through = pd.Timestamp(et(row.day, "10:15:10")).to_pydatetime()
    for _ in range(3):
        plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
    assert len(calls) == 49  # the first read of this minute, once a name
    row.revealed_through = pd.Timestamp(et(row.day, "10:15:50")).to_pydatetime()  # same closed minute
    plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
    assert len(calls) == 49
    row.revealed_through = pd.Timestamp(et(row.day, "10:16:10")).to_pydatetime()  # a new minute has closed
    plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
    assert len(calls) == 98
