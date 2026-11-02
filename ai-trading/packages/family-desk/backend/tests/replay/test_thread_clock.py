"""The day-trade thread's server-side clock (ADR-0018): it runs on wall time with nobody there, settles lazily on every
read, never stops for a crossed stop or for her own practice window, runs to the exchange close and rolls the day over
there, steps and jumps forward only, carries the account at the clock, lets a name she is on follow it without changing
the away rules, and Skip day runs to the close and opens the next day.
Real Postgres; the synthetic world of `tests/daily_world.py` (GAPPER 110 from the open to 11:30, then 100; FLAT 50 all
day). The wall clock is a list the test moves, injected as `Services.wall`, so "the user is logged out for an hour" is
one line.

Her practice window is 09:30 to 11:30 ET on 2026-09-28: a focus mark. The market runs 09:30 to 16:00."""

from datetime import timedelta

import pandas as pd
import pytest
from daily_world import DAYS, NOW, make_thread
from test_day_positions import _at, _bend
from test_replay_switch import _mark, _names, _row

from ai_trading.db.models import PracticeLedger, PracticePlan, ReplayDayList, User
from ai_trading.replay import clock as clock_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay.model import spans_of
from ai_trading.replay.session import ReplayProblem, SessionNotFound


@pytest.fixture
def wall(svc) -> list:
    """The wall clock, moved by the test (`wall[0] += ...`), read as `Services.wall`; `now` stays pinned."""
    now = [NOW]
    svc.wall = lambda: now[0]
    return now


def _thread_id(db_session, day: ReplayDayList) -> int:
    return db_session.get(PracticePlan, day.plan_id).thread_id


def _control(db_session, user_id, svc, thread_id, **kw):
    return clock_mod.control(
        db_session, user_id, thread_id, svc, **{"running": None, "speed": None, "to": None, "step": None, **kw}
    )


def _read(db_session, user_id, svc, thread_id):
    out = clock_mod.read(db_session, user_id, thread_id, svc)
    db_session.commit()
    return out


def _sync(db_session, user_id, svc, session_id):
    return session_mod.advance(
        db_session,
        user_id,
        session_id,
        svc,
        to=None,
        step=None,
        sync=True,
        interval=None,
        min_size=0,
        min_notional=0,
        max_prints=50,
    )


def _started(db_session, user_id, svc, *extra):
    """A thread with the day started on GAPPER (the clock at the open): `(thread id, day list, GAPPER's session)`."""
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, *extra)
    return _thread_id(db_session, row), row, gapper


# -- the clock runs on wall time ---------------------------------------------------------------------------------


def test_a_running_clock_moves_with_wall_time_while_nobody_is_there(db_session, user_id, svc, wall) -> None:
    thread_id, row, _ = _started(db_session, user_id, svc)
    paused = _read(db_session, user_id, svc, thread_id)
    assert (paused["state"], paused["running"], paused["clock"]) == ("paused", False, _at("09:30"))

    playing = _control(db_session, user_id, svc, thread_id, running=True, speed=5)
    assert playing["state"] == "running" and playing["speed"] == 5 and playing["clock"] == _at("09:30")

    # She leaves for ten minutes: no request touches the thread. The next read finds the market at 10:20.
    wall[0] += timedelta(minutes=10)
    back = _read(db_session, user_id, svc, thread_id)
    assert back["clock"] == _at("09:30") + pd.Timedelta(minutes=50) and back["state"] == "running"
    assert back["server_now"] == wall[0] and "pause" not in back
    assert plan_mod.get_day_list(db_session, user_id, row.id).revealed_through == back["clock"]  # stored, not computed

    # Reading twice at the same instant moves nothing (the settle is idempotent), and a pause freezes the settled time.
    assert _read(db_session, user_id, svc, thread_id)["clock"] == back["clock"]
    wall[0] += timedelta(minutes=1)
    held = _control(db_session, user_id, svc, thread_id, running=False)
    assert held["state"] == "paused" and held["clock"] == back["clock"] + pd.Timedelta(minutes=5)
    wall[0] += timedelta(hours=2)
    assert _read(db_session, user_id, svc, thread_id)["clock"] == held["clock"]


def test_a_speed_change_settles_the_time_that_passed_at_the_old_speed(db_session, user_id, svc, wall) -> None:
    thread_id, _, _ = _started(db_session, user_id, svc)
    _control(db_session, user_id, svc, thread_id, running=True, speed=1)
    wall[0] += timedelta(minutes=10)
    changed = _control(db_session, user_id, svc, thread_id, speed=10)
    assert changed["clock"] == _at("09:40") and changed["speed"] == 10  # ten minutes at 1x, not at 10x
    wall[0] += timedelta(minutes=3)
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("10:10")
    with pytest.raises(ReplayProblem) as caught:
        _control(db_session, user_id, svc, thread_id, speed=3)
    assert caught.value.path == "speed"


def test_the_clock_runs_past_her_window_to_the_close_and_the_day_rolls_over(
    db_session, user_id, svc, wall, world
) -> None:
    _bend(world, "GAPPER", "10:00", None, open=113.0, high=113.0, low=113.0, close=113.0)
    thread_id, row, gapper = _started(db_session, user_id, svc)
    bought = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)["mark"]["price"]
    started = _read(db_session, user_id, svc, thread_id)
    assert started["window_end"] == _at("16:00")  # the market's close
    assert started["focus_end"] == _at("11:30")  # her window: a mark, not a stop

    _control(db_session, user_id, svc, thread_id, running=True, speed=10)
    wall[0] += timedelta(minutes=18)  # 180 market minutes at 10x: an hour past her 11:30 mark
    past = _read(db_session, user_id, svc, thread_id)
    assert (past["clock"], past["state"], past["running"]) == (_at("12:30"), "running", True)
    assert clock_mod.roll(db_session, user_id, thread_id, svc) is None  # short of the close: nothing to roll
    assert plan_mod.get_day_list(db_session, user_id, row.id).status == "practicing"

    wall[0] += timedelta(hours=3)  # nobody home: the market ran into the close
    opened = clock_mod.roll(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert opened is not None and opened.day_list is not None
    ended = plan_mod.get_day_list(db_session, user_id, row.id)
    assert ended.status == "ended" and ended.revealed_through == _at("16:00") and ended.clock_running is False
    (booked,) = db_session.query(PracticeLedger).filter_by(thread_id=thread_id).all()
    assert (booked.shares, float(booked.exit_price)) == (10, 113.0)  # flattened at the close
    assert float(booked.pnl_usd) == round(10 * (113.0 - bought), 2)
    assert opened.day_list.day_no == 2 and opened.day_list.status == "listed"
    assert opened.day_list.clock_speed == 10  # the speed carries over
    now = _read(db_session, user_id, svc, thread_id)
    assert (now["state"], now["day_no"], now["clock"]) == ("listed", 2, None)
    assert clock_mod.roll(db_session, user_id, thread_id, svc) is None  # nothing left to roll: the next day is listed


def test_a_paused_clock_never_rolls_and_a_step_to_the_close_does(db_session, user_id, svc, wall) -> None:
    thread_id, row, _ = _started(db_session, user_id, svc)
    wall[0] += timedelta(hours=9)  # paused: wall time passing moves nothing
    assert clock_mod.roll(db_session, user_id, thread_id, svc) is None
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("09:30")

    jumped = _control(db_session, user_id, svc, thread_id, to=_at("17:00").to_pydatetime())
    assert jumped["clock"] == _at("16:00") and jumped["running"] is False  # the close, not her 11:30 mark
    assert _control(db_session, user_id, svc, thread_id, running=True)["running"] is False  # nothing left to run
    assert clock_mod.roll(db_session, user_id, thread_id, svc) is not None
    db_session.commit()
    assert plan_mod.get_day_list(db_session, user_id, row.id).status == "ended"


def test_a_crossed_stop_flags_the_position_and_the_clock_runs_on(db_session, user_id, svc, wall, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=48.5)  # crosses a stop at 49 in the 10:20 bar
    thread_id, row, _ = _started(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10, stopPrice=49.0)
    _control(db_session, user_id, svc, thread_id, running=True, speed=10)
    wall[0] += timedelta(minutes=20)  # 200 market minutes: well past the 10:21 crossing
    out = _read(db_session, user_id, svc, thread_id)
    assert (out["clock"], out["running"], out["state"]) == (_at("12:50"), True, "running")  # time did not stop
    assert _row(db_session, flat.id).stop_hit_at == _at("10:21")  # the stop never exits: it flags the position
    assert len(session_mod.open_positions(db_session, row.id)) == 1  # and the position is still open


def test_a_resting_order_the_running_clock_reaches_fills_while_she_is_away_and_is_booked_at_the_day_end(
    db_session, user_id, svc, wall, world
) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)  # the tape dips through a 49.5 limit at 10:21
    thread_id, row, _ = _started(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    session_mod.place_order(
        db_session, user_id, flat.id, svc, {"side": "buy", "orderType": "limit", "limitPrice": 49.5, "shares": 10}
    )
    db_session.commit()
    _control(db_session, user_id, svc, thread_id, running=True, speed=10)
    wall[0] += timedelta(hours=1)  # logged out: nobody syncs FLAT while the market runs to the close
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("16:00")

    ended, _ = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert ended.status == "ended"
    order = _row(db_session, flat.id).orders[0]
    assert (order["status"], order["fill_price"], order["reason"]) == ("filled", 49.5, None)  # not "The day ended"
    (entry, exit_) = session_mod._load_marks(db_session, flat.id)
    assert (entry.kind, entry.price, entry.at) == ("long_entry", 49.5, _at("10:21"))  # at its bar, inside the span
    assert (exit_.kind, exit_.price, exit_.at) == ("long_exit", 50.0, _at("16:00"))  # flattened at the close
    (booked,) = db_session.query(PracticeLedger).filter_by(thread_id=thread_id).all()
    assert (booked.shares, float(booked.pnl_usd)) == (10, 5.0)  # the balance moved without her


# -- the account at the clock -------------------------------------------------------------------------------------


def test_the_balance_follows_the_open_positions_as_the_clock_runs(db_session, user_id, svc, wall, world) -> None:
    _bend(world, "GAPPER", "10:00", "10:30", open=112.0, high=112.0, low=112.0, close=112.0)
    _bend(world, "GAPPER", "10:30", None, open=115.0, high=115.0, low=115.0, close=115.0)
    _bend(world, "FLAT", "10:00", None, open=52.0, high=52.0, low=52.0, close=52.0)
    thread_id, row, gapper = _started(db_session, user_id, svc, "FLAT")
    bought = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)["mark"][
        "price"
    ]  # long 10 (106 pre-open)
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    sold = _mark(db_session, user_id, svc, flat.id, "short_entry", shares=20)["mark"]["price"]  # short 20 at 50

    start = _read(db_session, user_id, svc, thread_id)["account"]
    assert (start["balance"], start["equity_usd"], start["positions"]) == (50_000.0, 50_000.0, 2)

    _control(db_session, user_id, svc, thread_id, running=True, speed=10)
    wall[0] += timedelta(minutes=3)  # 30 market minutes: the clock is at 10:00
    mid = _read(db_session, user_id, svc, thread_id)
    assert mid["clock"] == _at("10:00")
    # the last closed bar is 09:59: GAPPER 110 and FLAT 50, the day's own prices before the bends
    assert mid["account"]["open_pnl_usd"] == 10 * (110.0 - bought) + 20 * (sold - 50.0)
    wall[0] += timedelta(minutes=4)  # 10:40: GAPPER 115, FLAT 52 (short 20)
    later = _read(db_session, user_id, svc, thread_id)
    assert later["clock"] == _at("10:40")
    open_pnl = 10 * (115.0 - bought) + 20 * (sold - 52.0)
    assert later["account"]["open_pnl_usd"] == open_pnl and later["account"]["equity_usd"] == 50_000.0 + open_pnl
    assert later["account"]["balance"] == 50_000.0 and later["account"]["positions"] == 2  # nothing realized yet
    assert later["account"]["as_of"] == later["clock"]  # priced at the clock, never past it
    assert open_pnl != mid["account"]["open_pnl_usd"]  # the balance moved with nobody asking


# -- step and jump ------------------------------------------------------------------------------------------------


def test_step_and_jump_move_the_clock_forward_only_and_a_running_clock_keeps_running(
    db_session, user_id, svc, wall
) -> None:
    thread_id, _, _ = _started(db_session, user_id, svc)
    assert _control(db_session, user_id, svc, thread_id, step="bar")["clock"] == _at("09:35")
    assert _control(db_session, user_id, svc, thread_id, to=_at("09:50").to_pydatetime())["clock"] == _at("09:50")
    assert _control(db_session, user_id, svc, thread_id, to=_at("09:40").to_pydatetime())["clock"] == _at("09:50")
    assert _control(db_session, user_id, svc, thread_id, to=_at("13:00").to_pydatetime())["clock"] == _at("13:00")
    assert _control(db_session, user_id, svc, thread_id, to=_at("17:00").to_pydatetime())["clock"] == _at("16:00")
    with pytest.raises(ReplayProblem) as caught:
        _control(db_session, user_id, svc, thread_id, to=pd.Timestamp("2026-09-28T10:00:00").to_pydatetime())
    assert caught.value.message == "Send the time with its UTC offset"
    with pytest.raises(ReplayProblem) as nothing:
        _control(db_session, user_id, svc, thread_id, step="next_signal")
    assert nothing.value.message == "No more signals today"


def test_step_from_a_running_clock_keeps_it_running(db_session, user_id, svc, wall) -> None:
    thread_id, _, _ = _started(db_session, user_id, svc)
    _control(db_session, user_id, svc, thread_id, running=True, speed=1)
    wall[0] += timedelta(seconds=30)
    out = _control(db_session, user_id, svc, thread_id, step="bar")  # settled to 09:30:30, then the next 5-minute close
    assert out["clock"] == _at("09:35") and out["running"] is True and out["state"] == "running"


def test_the_clock_needs_a_day_that_has_started(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    thread = plan_mod.threads_mod.active_thread(db_session, user_id)
    with pytest.raises(ReplayProblem) as caught:
        _control(db_session, user_id, svc, thread.id, running=True)
    assert caught.value.status == 409
    assert clock_mod.read(db_session, user_id, thread.id, svc)["state"] == "no_day"


# -- names follow the clock; the old rules hold for one she left --------------------------------------------------


def test_a_name_she_is_on_follows_the_clock_quietly_and_one_she_left_is_an_away_span(
    db_session, user_id, svc, wall
) -> None:
    thread_id, row, gapper = _started(db_session, user_id, svc, "FLAT")
    _control(db_session, user_id, svc, thread_id, running=True, speed=5)

    wall[0] += timedelta(seconds=4)  # 20 market seconds: she is watching GAPPER, the screen syncs
    frame = _sync(db_session, user_id, svc, gapper.id)
    assert (
        frame["revealed_through"] == _at("09:30") + pd.Timedelta(seconds=20)
        and frame["day_clock"] == frame["revealed_through"]
    )
    assert _row(db_session, gapper.id).away == []  # the same minutes she was watching: not an away span

    wall[0] += timedelta(minutes=2)  # she went to the Portfolio for two minutes (ten market minutes)
    back = _sync(db_session, user_id, svc, gapper.id)
    assert back["revealed_through"] == _at("09:30") + pd.Timedelta(seconds=620)
    assert spans_of(_row(db_session, gapper.id).away) == [
        (_at("09:30") + pd.Timedelta(seconds=20), _at("09:30") + pd.Timedelta(seconds=620))
    ]
    # No lookahead: nothing past the clock is in the frame, and a name she never opened is not written at all.
    assert all(bar["t"] + pd.Timedelta(minutes=5) <= back["day_clock"] for bar in back["bars"])
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert flat.revealed_through == back["day_clock"]


def test_a_mark_on_a_watched_name_lifts_it_but_a_name_left_behind_must_be_caught_up(
    db_session, user_id, svc, wall
) -> None:
    thread_id, _, gapper = _started(db_session, user_id, svc)
    _control(db_session, user_id, svc, thread_id, running=True, speed=5)
    wall[0] += timedelta(seconds=3)  # the clock ran 15 market seconds since her last sync
    placed = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)
    assert placed["mark"]["at"] == _at("09:30") + pd.Timedelta(seconds=15)  # stamped at the clock, no "behind" refusal
    wall[0] += timedelta(minutes=5)  # then she left it for five minutes
    with pytest.raises(ReplayProblem) as caught:
        _mark(db_session, user_id, svc, gapper.id, "long_exit")
    assert "behind the day clock" in caught.value.message


def test_a_stranger_gets_not_found_before_anything_settles_or_moves(db_session, user_id, svc, wall) -> None:
    thread_id, row, gapper = _started(db_session, user_id, svc)
    _control(db_session, user_id, svc, thread_id, running=True, speed=5)
    wall[0] += timedelta(minutes=5)
    other = User(email="other@example.com", settings={})
    db_session.add(other)
    db_session.flush()
    for call in (
        lambda: _sync(db_session, other.id, svc, gapper.id),
        lambda: _mark(db_session, other.id, svc, gapper.id, "long_entry", shares=1),
    ):
        with pytest.raises(SessionNotFound):
            call()
    with pytest.raises(plan_mod.threads_mod.ThreadNotFound):
        clock_mod.read(db_session, other.id, thread_id, svc)
    db_session.expire_all()
    assert db_session.get(ReplayDayList, row.id).revealed_through == _at("09:30")  # nobody who owns it has read it yet


# -- skip day -----------------------------------------------------------------------------------------------------


def test_skip_day_runs_to_the_close_flattens_the_position_and_opens_the_next_day(
    db_session, user_id, svc, wall, world
) -> None:
    _bend(world, "GAPPER", "10:00", None, open=113.0, high=113.0, low=113.0, close=113.0)
    thread_id, row, gapper = _started(db_session, user_id, svc)
    bought = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)["mark"]["price"]
    _control(db_session, user_id, svc, thread_id, speed=5)

    ended, opened = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert ended.id == row.id and ended.status == "ended" and ended.revealed_through == _at("16:00")
    ledger = db_session.query(PracticeLedger).filter_by(thread_id=thread_id).all()
    pnl = round(10 * (113.0 - bought), 2)
    assert [(e.shares, float(e.exit_price), float(e.pnl_usd)) for e in ledger] == [
        (10, 113.0, pnl)
    ]  # exited at the close
    assert opened.day_list is not None and opened.day_list.id != row.id and opened.day_list.status == "listed"
    assert opened.day_list.day_no == 2 and opened.day_list.clock_speed == 5  # the speed she chose carries over
    out = _read(db_session, user_id, svc, thread_id)
    assert out["state"] == "listed" and out["day_list_id"] == opened.day_list.id and out["clock"] is None
    assert out["account"]["balance"] == 50_000.0 + pnl  # the new balance, from the ledger

    # A day she never started is a Pass: skip books nothing and opens the one after.
    skipped, after = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert skipped.id == opened.day_list.id and skipped.status == "ended" and after.day_list.day_no == 3
    assert db_session.query(PracticeLedger).filter_by(thread_id=thread_id).count() == 1


def test_skip_day_ends_a_running_clock_with_a_flagged_stop(db_session, user_id, svc, wall, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=48.5)
    thread_id, row, _ = _started(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10, stopPrice=49.0)
    _control(db_session, user_id, svc, thread_id, running=True)
    ended, _ = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    assert ended.status == "ended" and ended.clock_running is False and ended.revealed_through == _at("16:00")
    assert float(db_session.query(PracticeLedger).filter_by(thread_id=thread_id).one().exit_price) == 50.0
    assert DAYS[0] == row.day  # the stop crossed at 10:21 did not matter to the skip
