"""The freestyle thread (ADR-0025): positions persist, one clock moves forward only, one price marks everything.

The owner's bug: a Jump across an open ended the day and sold whatever she held. These tests pin the opposite on a real
Postgres and the synthetic world of `tests/daily_world.py` (see `freestyle_world.py` for its prices): nothing the clock
crosses (a close, a night, a weekend, an open, a Jump, Next open, a long run, a logout, a thread close) closes, ends or
flattens a position; it changes only by her trade, a resting order of hers filling, or a split.
"""

from datetime import timedelta

import pandas as pd
import pytest
from freestyle_world import (
    DAYS,
    at,
    bend,
    control,
    friday_before,
    jump,
    lane,
    ledger,
    mark,
    order,
    portfolio,
    read,
    start,
    sync,
)
from sqlalchemy import select, text

from ai_trading.db.models import PracticeMark, PracticeThread
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import positions as positions_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.session import ReplayProblem


@pytest.fixture
def wall(svc) -> list:
    """The wall clock, moved by the test (`wall[0] += ...`), read as `Services.wall`; `now` stays pinned."""
    now = [pd.Timestamp("2026-10-24T16:00:00Z").to_pydatetime()]
    svc.wall = lambda: now[0]
    return now


def _held(db_session, svc, thread) -> list[dict]:
    return portfolio(db_session, svc, thread)["positions"]


def _auto_marks(db_session, thread) -> list[PracticeMark]:
    return list(
        db_session.execute(
            select(PracticeMark)
            .join_from(PracticeMark, session_mod.ReplaySession)
            .where(session_mod.ReplaySession.thread_id == thread.id, PracticeMark.source == "auto")
        ).scalars()
    )


# -- (a) the owner's bug ---------------------------------------------------------------------------------------------


def test_a_position_survives_a_jump_across_two_closes_and_is_marked_at_the_new_time(db_session, user_id, svc) -> None:
    """Open Monday 10:00 and do nothing: the Jump to Wednesday leaves the same shares at the same cost, priced at
    Wednesday's price, and the ledger has not moved."""
    thread = start(db_session, user_id, svc)  # Mon 10:00, GAPPER at 110
    gapper = lane(db_session, user_id, svc, thread, "GAPPER")
    bought = mark(db_session, user_id, svc, gapper, "long_entry", shares=100)
    assert bought["mark"]["price"] == 110.0
    before = portfolio(db_session, svc, thread)
    assert before["account"]["equity_usd"] == 50_000.0 and before["positions"][0]["unrealized_usd"] == 0.0

    moved = jump(db_session, user_id, svc, thread, at(2, "12:00"))  # Wed noon: GAPPER is back at 100
    assert moved["clock"] == at(2, "12:00") and moved["state"] == "paused"

    [held] = _held(db_session, svc, thread)
    assert (held["symbol"], held["side"], held["shares"], held["avg_cost"]) == ("GAPPER", "long", 100, 110.0)
    assert held["price"] == 100.0 and held["unrealized_usd"] == -1000.0
    after = portfolio(db_session, svc, thread)
    assert after["account"]["equity_usd"] == 49_000.0 and after["account"]["balance"] == 50_000.0
    assert ledger(db_session, thread) == [] and _auto_marks(db_session, thread) == []
    db_session.refresh(gapper)
    assert gapper.status == "active"
    assert [m.kind for m in session_mod._load_marks(db_session, gapper.id)] == ["long_entry"]


def test_a_position_survives_next_open_a_weekend_a_long_run_and_a_logout(db_session, user_id, svc, wall) -> None:
    thread = start(db_session, user_id, svc, friday_before("10:00"))  # Friday 2026-09-25
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    mark(db_session, user_id, svc, flat, "long_entry", shares=100)

    # Next open: Friday 10:00 -> the Monday open, over the weekend (the first open after T is the next session's)
    nxt = clock_mod.next_open(db_session, user_id, thread.id, svc)
    assert nxt == at(0, "09:30")
    jumped = jump(db_session, user_id, svc, thread, nxt)
    assert jumped["clock"] == at(0, "09:30") and [p["shares"] for p in _held(db_session, svc, thread)] == [100]

    # Ten-x play across three opens: 3 days at 10x is 7.2 wall hours; she is logged out for all of it
    control(db_session, user_id, svc, thread, running=True, speed=10)
    wall[0] += timedelta(hours=7, minutes=30)  # no request touches the thread
    out = read(db_session, user_id, svc, thread)
    assert out["clock"] >= at(2, "09:30") and out["state"] == "running"
    [held] = _held(db_session, svc, thread)
    assert (held["shares"], held["avg_cost"], held["price"]) == (100, 50.0, 50.0)
    assert ledger(db_session, thread) == [] and _auto_marks(db_session, thread) == []

    # Paused over two more closes: still the same book
    control(db_session, user_id, svc, thread, running=False)
    wall[0] += timedelta(days=2)
    assert [p["shares"] for p in _held(db_session, svc, thread)] == [100]


def test_closing_the_thread_cancels_orders_freezes_time_and_keeps_positions(db_session, user_id, svc, wall) -> None:
    thread = start(db_session, user_id, svc)
    gapper = lane(db_session, user_id, svc, thread, "GAPPER")
    mark(db_session, user_id, svc, gapper, "long_entry", shares=100)
    order(db_session, user_id, svc, gapper, "sell", "limit", limitPrice=150.0, timeInForce="gtc")
    jump(db_session, user_id, svc, thread, at(2, "12:00"))
    control(db_session, user_id, svc, thread, running=True)

    closed = threads_mod.close_thread(db_session, user_id, thread.id, svc.now(), svc)
    db_session.commit()
    assert closed.status == "closed" and closed.clock_running is False
    frozen = pd.Timestamp(closed.clock_at)
    wall[0] += timedelta(days=3)
    assert pd.Timestamp(read(db_session, user_id, svc, thread)["clock"]) == frozen  # time stands still

    [held] = _held(db_session, svc, thread)
    assert (held["shares"], held["price"]) == (100, 100.0)
    db_session.refresh(gapper)
    assert [(o["status"], o["reason"]) for o in gapper.orders] == [("cancelled", "Thread closed")]
    assert ledger(db_session, thread) == []
    assert portfolio(db_session, svc, thread)["account"]["equity_usd"] == 49_000.0


# -- (c) forward only -----------------------------------------------------------------------------------------------


def test_a_past_to_is_a_422_and_to_equal_to_the_clock_is_a_no_op(db_session, user_id, svc) -> None:
    thread = start(db_session, user_id, svc)
    jump(db_session, user_id, svc, thread, at(1, "11:00"))
    with pytest.raises(ReplayProblem) as past:
        jump(db_session, user_id, svc, thread, at(1, "10:59"))
    assert (past.value.status, past.value.path, past.value.message) == (422, "to", clock_mod.TIME_FORWARD_ONLY)
    same = jump(db_session, user_id, svc, thread, at(1, "11:00"))  # `to == T`
    assert same["clock"] == at(1, "11:00")
    with pytest.raises(ReplayProblem) as naive:
        control(db_session, user_id, svc, thread, to=pd.Timestamp("2026-09-30T12:00:00").to_pydatetime())
    assert naive.value.path == "to"


def test_a_stale_writer_can_never_rewind_the_clock(db_session, user_id, svc, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two tabs: while one move is crossing time, another commits a later clock. The guarded write (`clock_at <= :t`)
    loses cleanly (409) instead of rewinding it."""
    thread = start(db_session, user_id, svc)
    lane(db_session, user_id, svc, thread, "FLAT")  # a lane that holds nothing: `_cross` has no work, patched anyway
    real = clock_mod._cross

    def other_tab(db, svc_, thread_, t0, t1):
        real(db, svc_, thread_, t0, t1)
        db.execute(
            PracticeThread.__table__.update()
            .where(PracticeThread.id == thread_.id)
            .values(clock_at=at(3, "10:00").to_pydatetime())
        )

    monkeypatch.setattr(clock_mod, "_cross", other_tab)
    with pytest.raises(ReplayProblem) as lost:
        jump(db_session, user_id, svc, thread, at(1, "10:00"))
    assert lost.value.status == 409
    db_session.rollback()
    db_session.refresh(thread)
    assert pd.Timestamp(thread.clock_at) == at(0, "10:00")  # nothing was written
    # And `advance_thread` with an earlier target clamps to T instead of moving back
    monkeypatch.setattr(clock_mod, "_cross", real)
    clock_mod.advance_thread(db_session, svc, thread, at(0, "09:00"))
    assert pd.Timestamp(thread.clock_at) == at(0, "10:00")


def test_the_horizon_bounds_a_jump_and_a_running_clock_stops_there(db_session, user_id, svc, wall) -> None:
    svc.now = lambda: at(4, "20:30").to_pydatetime()  # the last session with data is Friday 2026-10-02
    assert clock_mod.horizon(svc.now()) == at(4, "20:00")
    thread = start(db_session, user_id, svc, at(2, "10:00"))
    view = read(db_session, user_id, svc, thread)
    assert view["horizon"] == at(4, "20:00") and view["pause"] is None

    with pytest.raises(ReplayProblem) as beyond:
        jump(db_session, user_id, svc, thread, at(4, "20:01"))
    assert beyond.value.status == 422 and beyond.value.path == "to"
    assert jump(db_session, user_id, svc, thread, at(4, "20:00"))["clock"] == at(4, "20:00")  # `to == horizon` is fine

    thread = start(db_session, user_id, svc, at(3, "10:00"))
    control(db_session, user_id, svc, thread, running=True, speed=10)
    wall[0] += timedelta(hours=12)  # ten simulated days
    stopped = read(db_session, user_id, svc, thread)
    assert stopped["clock"] == at(4, "20:00") and stopped["state"] == "paused"
    assert stopped["pause"] == {"kind": "horizon"} and stopped["running"] is False


def test_next_open_is_the_first_regular_open_after_the_clock(db_session, user_id, svc) -> None:
    assert positions_mod.next_open(friday_before("10:00")) == at(0, "09:30")  # Friday -> Monday, over the weekend
    assert positions_mod.next_open(at(0, "09:00")) == at(0, "09:30")  # before today's open: today's
    assert positions_mod.next_open(at(0, "09:30")) == at(1, "09:30")  # strictly after
    thread = start(db_session, user_id, svc)
    assert clock_mod.next_open(db_session, user_id, thread.id, svc) == at(1, "09:30")
    assert read(db_session, user_id, svc, thread)["next_open"] == at(1, "09:30")


# -- (d) orders across days ----------------------------------------------------------------------------------------


def test_a_resting_stop_sell_fills_inside_a_multi_day_jump_at_the_gap_open(db_session, user_id, svc, world) -> None:
    bend(world, "FLAT", 1, "04:00", None, open=40.0, high=40.0, low=40.0, close=40.0)  # Tuesday gaps down to 40
    thread = start(db_session, user_id, svc)
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    mark(db_session, user_id, svc, flat, "long_entry", shares=100)
    placed = order(db_session, user_id, svc, flat, "sell", "stop", stopPrice=48.0, timeInForce="gtc")
    assert placed["order"]["reduce_only"] is True and placed["order"]["tif"] == "gtc"

    jump(db_session, user_id, svc, thread, at(2, "12:00"))  # nobody watched Tuesday

    db_session.refresh(flat)
    [filled] = flat.orders
    assert (filled["status"], filled["fill_price"]) == ("filled", 40.0)  # the gap open, not the stop price
    assert pd.Timestamp(filled["closed_at"]) == at(1, "04:01")
    assert _held(db_session, svc, thread) == []
    [row] = ledger(db_session, thread)
    assert (float(row.pnl_usd), float(row.exit_price), row.day) == (-1000.0, 40.0, DAYS[1])  # booked on the ET date
    assert portfolio(db_session, svc, thread)["account"]["balance"] == 49_000.0


def test_a_day_order_expires_at_its_session_end_and_does_not_fill_the_next_day(db_session, user_id, svc, world) -> None:
    bend(world, "FLAT", 1, "10:00", None, open=40.0, high=40.0, low=40.0, close=40.0)  # Tuesday trades at 40
    thread = start(db_session, user_id, svc)
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    day_order = order(db_session, user_id, svc, flat, "buy", "limit", limitPrice=45.0, timeInForce="day")
    gtc_order = order(db_session, user_id, svc, flat, "buy", "limit", limitPrice=45.0, timeInForce="gtc")
    assert pd.Timestamp(day_order["order"]["expires_at"]) == at(0, "20:00") and gtc_order["order"]["expires_at"] is None

    jump(db_session, user_id, svc, thread, at(1, "12:00"))

    db_session.refresh(flat)
    by_id = {o["id"]: o for o in flat.orders}
    assert (by_id[1]["status"], by_id[1]["reason"]) == ("cancelled", "Expired")
    assert pd.Timestamp(by_id[1]["closed_at"]) == at(0, "20:00")
    assert (by_id[2]["status"], by_id[2]["fill_price"]) == ("filled", 40.0)  # the GTC order took Tuesday's dip
    assert [p["shares"] for p in _held(db_session, svc, thread)] == [100]  # one fill, not two


def test_a_reduce_only_order_is_cancelled_when_she_has_already_exited(db_session, user_id, svc, world) -> None:
    bend(world, "FLAT", 1, "10:00", None, open=61.0, high=61.0, low=61.0, close=61.0)  # Tuesday trades through 60
    thread = start(db_session, user_id, svc)
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    mark(db_session, user_id, svc, flat, "long_entry", shares=100)
    target = order(db_session, user_id, svc, flat, "sell", "limit", limitPrice=60.0)
    assert target["order"]["reduce_only"] is True
    mark(db_session, user_id, svc, flat, "long_exit")  # she gets out by hand and forgets the order

    jump(db_session, user_id, svc, thread, at(1, "12:00"))

    db_session.refresh(flat)
    [cancelled] = flat.orders
    assert (cancelled["status"], cancelled["reason"]) == ("cancelled", "Position already closed")
    assert _held(db_session, svc, thread) == []  # and no short was opened days later
    assert [m.kind for m in session_mod._load_marks(db_session, flat.id)] == ["long_entry", "long_exit"]


def test_two_fills_of_one_move_compete_for_one_balance(db_session, user_id, svc, world) -> None:
    """Both buy stops were affordable when placed (each reserves its trigger); both gap past it on Tuesday, so the
    earlier fill is the only one the account can carry and the other is cancelled with the cash reason."""
    bend(world, "FLAT", 1, "04:00", None, open=70.0, high=70.0, low=70.0, close=70.0)
    bend(world, "GAPPER", 1, "04:00", None, open=140.0, high=140.0, low=140.0, close=140.0)
    thread = start(db_session, user_id, svc, balance=10_000)
    flat, gapper = lane(db_session, user_id, svc, thread, "FLAT"), lane(db_session, user_id, svc, thread, "GAPPER")
    order(db_session, user_id, svc, flat, "buy", "stop", stopPrice=55.0, shares=90)  # reserves 4,950
    order(db_session, user_id, svc, gapper, "buy", "stop", stopPrice=120.0, shares=40)  # reserves 4,800

    jump(db_session, user_id, svc, thread, at(1, "12:00"))

    db_session.refresh(flat)
    db_session.refresh(gapper)
    orders = [o for r in (flat, gapper) for o in r.orders]
    states = sorted((o["status"], o["reason"] and o["reason"].split(" · ")[0]) for o in orders)
    assert states == [("cancelled", "Not enough practice cash"), ("filled", None)]
    assert len(_held(db_session, svc, thread)) == 1


def test_a_stop_line_inside_a_jump_is_flagged_and_never_exits(db_session, user_id, svc, world) -> None:
    bend(world, "FLAT", 1, "10:00", None, open=40.0, high=40.0, low=40.0, close=40.0)
    thread = start(db_session, user_id, svc)
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    mark(db_session, user_id, svc, flat, "long_entry", shares=100, stopPrice=48.0)

    jump(db_session, user_id, svc, thread, at(2, "12:00"))

    [held] = _held(db_session, svc, thread)
    assert held["shares"] == 100 and held["stop_price"] == 48.0
    assert pd.Timestamp(held["stop_hit_at"]) == at(1, "10:01")  # flagged at the bar that crossed it
    assert ledger(db_session, thread) == []


# -- (e) splits -----------------------------------------------------------------------------------------------------


def test_a_split_across_a_jump_restates_the_position_and_the_orders_with_no_pnl(db_session, user_id, svc) -> None:
    thread = start(db_session, user_id, svc)  # SPLITTER is 100 until DAYS[2] and 50 from DAYS[3]
    splitter = lane(db_session, user_id, svc, thread, "SPLITTER")
    mark(db_session, user_id, svc, splitter, "long_entry", shares=100)
    order(db_session, user_id, svc, splitter, "buy", "limit", limitPrice=90.0, shares=30)  # resting below the market
    before = portfolio(db_session, svc, thread)["account"]["equity_usd"]

    jump(db_session, user_id, svc, thread, at(3, "12:00"))  # past the ex-date

    [held] = _held(db_session, svc, thread)
    assert (held["shares"], held["avg_cost"], held["price"], held["unrealized_usd"]) == (200, 50.0, 50.0, 0.0)
    assert portfolio(db_session, svc, thread)["account"]["equity_usd"] == before
    db_session.refresh(splitter)
    [resting] = splitter.orders
    assert (resting["status"], resting["shares"], resting["limit_price"]) == ("working", 60, 45.0)
    [split] = [m for m in session_mod._load_marks(db_session, splitter.id) if m.kind == "split"]
    assert split.source == "auto" and split.position_before["ratio"] == 2.0
    assert split.position_before["shares_after"] == 200
    assert pd.Timestamp(split.at) == at(3, "04:00") and ledger(db_session, thread) == []


# -- (f) nothing after T leaks ----------------------------------------------------------------------------------------


def test_nothing_after_the_thread_time_leaks_across_a_later_day(db_session, user_id, svc, world) -> None:
    """Bend every bar after T, a later bar of the same day and a whole later day: the portfolio, the account, the feed
    and the mark all stay at what T could have seen."""
    thread = start(db_session, user_id, svc)  # Monday 10:00
    gapper = lane(db_session, user_id, svc, thread, "GAPPER")
    mark(db_session, user_id, svc, gapper, "long_entry", shares=100)
    bend(world, "GAPPER", 0, "10:05", None, open=999.0, high=999.0, low=999.0, close=999.0)
    bend(world, "GAPPER", 2, "04:00", None, open=999.0, high=999.0, low=999.0, close=999.0)

    [held] = _held(db_session, svc, thread)
    assert held["price"] == 110.0 and portfolio(db_session, svc, thread)["account"]["equity_usd"] == 50_000.0
    found = positions_mod.mark_at(svc, svc.store_factory(db_session), "GAPPER", at(0, "10:00"))
    assert found is not None and found.price == 110.0
    feed = session_mod.feed(db_session, user_id, gapper.id, svc, interval="5m")
    assert max(bar["h"] for bar in feed["bars"]) < 999.0 and feed["last"]["price"] == 110.0
    assert feed["thread_time"] == at(0, "10:00") and feed["data_through"] == at(0, "10:00")

    jump(db_session, user_id, svc, thread, at(2, "12:00"))  # now (and only now) Wednesday's bars exist for her
    assert _held(db_session, svc, thread)[0]["price"] == 999.0


# -- (8) the one price ----------------------------------------------------------------------------------------------


def test_mark_at_the_open_uses_the_previous_session_print_not_the_entry(db_session, user_id, svc, world) -> None:
    """At 09:30:00 of a session whose name has not printed yet, the mark is the previous session's last print."""
    frame = world.minutes["GAPPER"]
    local = frame.index.tz_convert("America/New_York")
    early = (local.date == DAYS[2]) & (frame.index < at(2, "09:31"))
    world.minutes["GAPPER"] = frame[~early]  # Wednesday's first bars are missing (a late open)
    store = svc.store_factory(db_session)
    found = positions_mod.mark_at(svc, store, "GAPPER", at(2, "09:30"))
    assert found is not None
    assert (found.price, found.day) == (100.0, DAYS[1])  # Tuesday's last print, not Wednesday's 110 and not a cost
    assert found.at == at(1, "20:00")
    later = positions_mod.mark_at(svc, store, "GAPPER", at(2, "09:45"))
    assert later is not None and (later.price, later.day) == (110.0, DAYS[2])
    assert positions_mod.data_day(at(2, "03:00")) == DAYS[1] and positions_mod.data_day(at(2, "09:30")) == DAYS[2]
    assert positions_mod.data_day(pd.Timestamp("2026-09-27T16:00:00Z")) == pd.Timestamp("2026-09-25").date()  # Sunday


# -- caps and lanes ------------------------------------------------------------------------------------------------


def test_a_thread_tracks_at_most_the_held_cap_of_names_with_a_position_or_order(
    db_session, user_id, svc, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_mod, "MAX_HELD_NAMES", 2)
    thread = start(db_session, user_id, svc)
    flat, gapper, splitter = (lane(db_session, user_id, svc, thread, s) for s in ("FLAT", "GAPPER", "SPLITTER"))
    mark(db_session, user_id, svc, flat, "long_entry", shares=10)
    order(db_session, user_id, svc, gapper, "buy", "limit", limitPrice=90.0, shares=10)  # an order holds a name too
    with pytest.raises(ReplayProblem) as refused:
        mark(db_session, user_id, svc, splitter, "long_entry", shares=10)
    assert refused.value.status == 409 and "at most" in refused.value.message
    mark(db_session, user_id, svc, flat, "long_entry", shares=10)  # a name it already tracks still takes fills
    mark(db_session, user_id, svc, flat, "long_exit")  # and closing frees the name
    mark(db_session, user_id, svc, splitter, "long_entry", shares=10)


def test_a_lane_is_one_book_for_the_life_of_the_thread(db_session, user_id, svc) -> None:
    thread = start(db_session, user_id, svc)
    first = lane(db_session, user_id, svc, thread, "FLAT")
    mark(db_session, user_id, svc, first, "long_entry", shares=10)
    jump(db_session, user_id, svc, thread, at(2, "12:00"))
    again = lane(db_session, user_id, svc, thread, "FLAT")  # reopening a name resumes its book
    assert again.id == first.id
    sync(db_session, user_id, svc, again)
    assert pd.Timestamp(again.revealed_through) == at(2, "12:00")
    mark(db_session, user_id, svc, again, "long_entry", shares=5)  # a second fill, days later: the same position
    [held] = _held(db_session, svc, thread)
    assert (held["shares"], held["avg_cost"]) == (15, 50.0)


def test_a_name_cannot_move_the_threads_time(db_session, user_id, svc) -> None:
    thread = start(db_session, user_id, svc)
    flat = lane(db_session, user_id, svc, thread, "FLAT")
    for kwargs in ({"to": at(1, "10:00").to_pydatetime(), "step": None}, {"to": None, "step": "bar"}):
        with pytest.raises(ReplayProblem) as refused:
            session_mod.advance(
                db_session,
                user_id,
                flat.id,
                svc,
                interval=None,
                min_size=0,
                min_notional=0,
                max_prints=50,
                sync=False,
                **kwargs,
            )
        assert refused.value.status == 422
    assert read(db_session, user_id, svc, thread)["clock"] == at(0, "10:00")


def test_two_threads_of_one_owner_can_hold_the_same_name_on_the_same_data_day(db_session, user_id, svc) -> None:
    """Migration 0022: the one-active-row-per-owner-symbol-day index narrowed to standalone rows."""
    first, second = start(db_session, user_id, svc), start(db_session, user_id, svc)
    one, two = lane(db_session, user_id, svc, first, "FLAT"), lane(db_session, user_id, svc, second, "FLAT")
    assert one.id != two.id and one.day == two.day
    mark(db_session, user_id, svc, one, "long_entry", shares=10)
    mark(db_session, user_id, svc, two, "long_entry", shares=20)
    assert [p["shares"] for p in _held(db_session, svc, first)] == [10]
    assert [p["shares"] for p in _held(db_session, svc, second)] == [20]
    definition = db_session.execute(
        text("select indexdef from pg_indexes where indexname = 'uq_replay_sessions_owner_user_id_symbol_day_active'")
    ).scalar_one()
    assert "thread_id IS NULL" in definition
