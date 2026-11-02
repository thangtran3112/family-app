"""The day list's names at the day clock (`day_list_out(live=True)`): the stored candidate stays the list-time
snapshot, a `live` block follows the thread clock, and nothing in it reads a bar that has not closed by the clock.
Real Postgres; the synthetic world of `tests/daily_world.py`.

The world on 2026-09-28: GAPPER sits at 106 in the premarket (the "Gap up" filter lists it at that price) and at 110
from the open; its prior close is 100. Tests bend its later bars to prove the clock is the only cut."""

import pandas as pd
from test_day_positions import _at, _bend
from test_replay_plan import _advance, _first_list

from ai_trading.replay import plan as plan_mod


def _gapper(out) -> dict:
    return next(c for c in out["candidates"] if c["symbol"] == "GAPPER")


def _live_list(db_session, user_id, svc, row):
    return plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)


def test_the_live_block_follows_the_clock_while_the_list_values_stay_at_list_time(
    db_session, user_id, svc, world
) -> None:
    _bend(world, "GAPPER", "10:00", "10:30", open=112.0, high=112.0, low=112.0, close=112.0)
    _bend(world, "GAPPER", "10:30", None, open=130.0, high=130.0, low=130.0, close=130.0)
    row = _first_list(db_session, user_id, svc)
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    db_session.commit()

    at_open = _gapper(_live_list(db_session, user_id, svc, row))
    assert (
        pd.Timestamp(at_open["live"]["at"]) == _at("09:30") and at_open["live"]["price"] == 106.0
    )  # the 09:29 bar, the last one closed
    assert (
        at_open["live"]["today"] is False
    )  # no regular bar has closed: the metric block is still the previous session's

    _advance(db_session, user_id, svc, started.id, "10:15")
    db_session.commit()
    out = _live_list(db_session, user_id, svc, row)
    moved = _gapper(out)
    assert moved["live"]["price"] == 112.0, "the 10:14 bar, not the 130 that follows the clock"
    assert moved["live"]["change_pct"] == 12.0
    assert moved["live"]["today"] is True and moved["live"]["metrics"]["last"] == 112.0
    assert moved["live"]["metrics"]["volume"] > 0 and moved["live"]["metrics"]["gap_pct_open"] == 10.0
    # the snapshot is untouched: the list price and its metrics are the list time's
    assert moved["list_price"] == 106.0 and moved["metrics"]["list_price"] == 106.0
    assert pd.Timestamp(moved["live"]["at"]) == _at("10:15")

    _advance(db_session, user_id, svc, started.id, "10:45")
    db_session.commit()
    assert _gapper(_live_list(db_session, user_id, svc, row))["live"]["price"] == 130.0


def test_the_snapshot_reads_are_unchanged_and_no_live_block_without_live_or_after_the_day(
    db_session, user_id, svc
) -> None:
    row = _first_list(db_session, user_id, svc)
    before = plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
    assert before["clock"] == _at("09:30"), "the day's clock stands at its start, with no name opened"
    assert all(pd.Timestamp(c["live"]["at"]) <= _at("09:30") for c in before["candidates"]), (
        "read at the clock, no later"
    )
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    db_session.commit()
    _advance(db_session, user_id, svc, started.id, "10:00")
    db_session.commit()
    plain = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    assert all("live" not in c for c in plain["candidates"]), "a read without live is the snapshot"
    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.commit()
    ended = plan_mod.day_list_out(db_session, user_id, row.id, svc, live=True)
    assert ended["status"] == "ended" and all("live" not in c for c in ended["candidates"])
