"""The day-trade thread's server-side clock (ADR-0018): real time, shifted. It runs on wall time with nobody there,
exists from the moment the day opens (no name has to be opened), settles lazily on every read, and never stops: not
for a crossed stop, not for her practice window, not for the close, the night or the weekend. At 1x the gap between
the thread's time and real time stays constant; only Pause, the speed and Skip day change it. The day list hands over
to the next trading day when the clock reaches that day's start, carrying the clock. Steps and jumps are forward only,
the account is read at the clock, a name she is on follows it as far as its tape goes, and Skip day jumps to the
next start.
Real Postgres; the synthetic world of `tests/daily_world.py` (GAPPER 110 from the open to 11:30, then 100; FLAT 50 all
day; flat bars 04:00 to 20:00 each session, none overnight). The wall clock is a list the test moves, injected as
`Services.wall`, so "the user is logged out for an hour" is one line.

Her practice window is 09:30 to 11:30 ET on 2026-09-28: a focus mark. The tape runs 04:00 to 20:00; the next day starts
at 09:30 on 2026-09-29."""

from datetime import date, timedelta

import pandas as pd
import pytest
from daily_world import DAYS, NOW, make_thread
from test_day_positions import _at, _bend
from test_replay_plan import _first_list, _plan
from test_replay_switch import _mark, _names, _row

from ai_trading.core.calendar import et
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


def _gap(wall: list, out: dict) -> pd.Timedelta:
    """Real time minus the thread's time: the offset that must not change while the clock runs at 1x."""
    return pd.Timestamp(wall[0]) - out["clock"]


def test_the_clock_exists_before_any_name_is_opened_and_plays_from_the_summary(db_session, user_id, svc, wall) -> None:
    make_thread(db_session, user_id)
    row = _first_list(db_session, user_id, svc)
    thread_id = _thread_id(db_session, row)
    listed = _read(db_session, user_id, svc, thread_id)
    assert (listed["state"], listed["day_no"], listed["clock"]) == ("paused", 1, _at("09:30"))  # no name opened yet
    assert listed["next_start"] == et(DAYS[1], "09:30") and listed["account"]["positions"] == 0

    played = _control(db_session, user_id, svc, thread_id, running=True, speed=2)
    assert played["state"] == "running"
    wall[0] += timedelta(minutes=10)
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("09:50")
    assert plan_mod.get_day_list(db_session, user_id, row.id).status == "listed"  # still no name


def test_the_clock_flows_through_the_close_the_night_and_into_the_next_session(
    db_session, user_id, svc, wall, world
) -> None:
    _bend(world, "GAPPER", "10:00", None, open=113.0, high=113.0, low=113.0, close=113.0)
    thread_id, row, gapper = _started(db_session, user_id, svc)
    bought = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)["mark"]["price"]
    started = _read(db_session, user_id, svc, thread_id)
    assert started["window_end"] == _at("20:00")  # the tape: the extended session, not the 16:00 close
    assert started["focus_end"] == _at("11:30")  # her window: a mark, not a stop
    assert started["next_start"] == et(DAYS[1], "09:30")

    _control(db_session, user_id, svc, thread_id, running=True, speed=10)
    wall[0] += timedelta(minutes=18)  # 180 market minutes at 10x: an hour past her 11:30 mark
    past = _read(db_session, user_id, svc, thread_id)
    assert (past["clock"], past["state"]) == (_at("12:30"), "running")
    _control(db_session, user_id, svc, thread_id, speed=1)
    offset = _gap(wall, past)

    def at(hours: float, label: str):
        wall[0] += timedelta(hours=hours)
        opened = clock_mod.roll(db_session, user_id, thread_id, svc)
        db_session.commit()
        out = _read(db_session, user_id, svc, thread_id)
        assert _gap(wall, out) == offset, label  # never a jump: real time minus thread time is constant at 1x
        return opened, out

    opened, closing = at(3.5, "close")  # 16:00
    assert (closing["clock"], closing["state"], closing["day_no"], opened) == (_at("16:00"), "running", 1, None)
    assert plan_mod.get_day_list(db_session, user_id, row.id).status == "practicing"  # nothing happened at the close
    assert closing["account"]["open_pnl_usd"] == 10 * (113.0 - bought) and closing["account"]["positions"] == 1

    opened, after_hours = at(1.0, "after hours")  # 17:00: the clock is in the extended session, bars show
    assert after_hours["clock"] == _at("17:00") and opened is None
    frame = _sync(db_session, user_id, svc, gapper.id)
    assert frame["revealed_through"] == _at("17:00") and frame["day_clock"] == _at("17:00") and not frame["at_end"]
    assert any(bar["ext"] and bar["t"] >= _at("16:00") for bar in frame["bars"])  # after-hours bars are shown

    opened, night = at(4.0, "night")  # 21:00: past the tape's end, still the same day, nothing new to show
    assert night["clock"] == _at("21:00") and opened is None and night["day_no"] == 1
    frame = _sync(db_session, user_id, svc, gapper.id)
    assert frame["revealed_through"] == _at("20:00") and frame["day_clock"] == _at("20:00")  # the tape ends at 20:00
    assert frame["behind_clock"] is False and frame["at_end"] is True
    assert frame["bars"][-1]["t"] + pd.Timedelta(minutes=5) == _at("20:00")  # the rest of the tape, and not a bar more
    assert _sync(db_session, user_id, svc, gapper.id)["bars"] == []  # the night adds none
    assert night["account"]["open_pnl_usd"] == 10 * (113.0 - bought)  # the position waits, priced at the last print

    opened, premarket = at(7.0, "premarket")  # Tue 04:00: a new calendar date, still day 1's list
    assert premarket["clock"] == et(DAYS[1], "04:00") and opened is None and premarket["day_no"] == 1

    opened, open_ = at(5.5, "next session")  # Tue 09:30: the next session's start; the day hands over, clock unchanged
    assert opened is not None and opened.day_list is not None
    assert (open_["clock"], open_["day_no"], open_["state"], open_["speed"]) == (et(DAYS[1], "09:30"), 2, "running", 1)
    ended = plan_mod.get_day_list(db_session, user_id, row.id)
    assert ended.status == "ended" and ended.revealed_through == _at("20:00") and ended.clock_running is False
    (booked,) = db_session.query(PracticeLedger).filter_by(thread_id=thread_id).all()
    assert (booked.shares, float(booked.exit_price)) == (10, 113.0)  # flattened at the end of day 1's tape
    assert float(booked.pnl_usd) == round(10 * (113.0 - bought), 2)
    assert opened.day_list.day_no == 2 and opened.day_list.status == "listed" and opened.day_list.clock_running is True


def test_the_weekend_is_ordinary_time_the_clock_passes_through(db_session, user_id, svc, wall) -> None:
    friday = DAYS[4]  # Fri 2026-10-02; the plan's next day is Mon 2026-10-05
    make_thread(db_session, user_id)
    plan_mod.run_prep(db_session, svc, _plan(db_session, user_id, svc, firstDay=friday.isoformat()).id)
    row = plan_mod.open_next(db_session, user_id, svc).day_list
    db_session.commit()
    thread_id = _thread_id(db_session, row)
    assert _read(db_session, user_id, svc, thread_id)["next_start"] == et(date(2026, 10, 5), "09:30")
    start = et(friday, "09:30")
    _control(db_session, user_id, svc, thread_id, running=True)
    first = _read(db_session, user_id, svc, thread_id)
    assert first["clock"] == start
    offset = _gap(wall, first)
    for hours, label in ((6.5, "Fri close"), (24, "Sat 16:00"), (24, "Sun 16:00"), (16.5, "Mon 08:30")):
        wall[0] += timedelta(hours=hours)
        assert clock_mod.roll(db_session, user_id, thread_id, svc) is None  # the next session has not started
        out = _read(db_session, user_id, svc, thread_id)
        assert (out["state"], out["day_no"], _gap(wall, out)) == ("running", 1, offset), label
    assert out["clock"] == et(date(2026, 10, 5), "08:30")  # Saturday and Sunday went by at 1x, in order


def test_a_clock_that_ran_for_days_unwatched_hands_over_day_by_day(db_session, user_id, svc, wall, world) -> None:
    _bend(world, "GAPPER", "10:00", None, open=113.0, high=113.0, low=113.0, close=113.0)
    thread_id, row, gapper = _started(db_session, user_id, svc)
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)
    _control(db_session, user_id, svc, thread_id, running=True, speed=5)
    wall[0] += timedelta(hours=18)  # 90 market hours at 5x: Mon 09:30 + 3 days 18 hours = Fri 03:30
    opened = clock_mod.roll(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert opened is not None and opened.day_list is not None
    assert opened.day_list.day_no == 4 and opened.day_list.day == DAYS[3]  # Mon, Tue (a Pass) and Wed ended; Thu is up
    out = _read(db_session, user_id, svc, thread_id)
    assert out["clock"] == _at("09:30") + pd.Timedelta(hours=90) and out["running"] and out["speed"] == 5
    days = {d.day_no: d.status for d in db_session.query(ReplayDayList).filter_by(plan_id=row.plan_id)}
    assert days == {1: "ended", 2: "ended", 3: "ended", 4: "listed"}
    assert db_session.query(PracticeLedger).filter_by(thread_id=thread_id).count() == 1  # only day 1 traded


def test_a_paused_clock_never_hands_over_however_long_it_waits(db_session, user_id, svc, wall) -> None:
    thread_id, row, _ = _started(db_session, user_id, svc)
    wall[0] += timedelta(days=9)  # paused: wall time passing moves nothing
    assert clock_mod.roll(db_session, user_id, thread_id, svc) is None
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("09:30")
    assert plan_mod.get_day_list(db_session, user_id, row.id).status == "practicing"


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
    wall[0] += timedelta(hours=1)  # logged out: nobody syncs FLAT while the market runs on (ten hours at 10x)
    assert _read(db_session, user_id, svc, thread_id)["clock"] == _at("19:30")

    ended, _ = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert ended.status == "ended"
    order = _row(db_session, flat.id).orders[0]
    assert (order["status"], order["fill_price"], order["reason"]) == ("filled", 49.5, None)  # not "The day ended"
    (entry, exit_) = session_mod._load_marks(db_session, flat.id)
    assert (entry.kind, entry.price, entry.at) == ("long_entry", 49.5, _at("10:21"))  # at its bar, inside the span
    assert (exit_.kind, exit_.price, exit_.at) == ("long_exit", 50.0, _at("20:00"))  # flattened at the tape's end
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
    # buying power: the balance less what the open positions cost (a short counts as a long)
    assert start["buying_power_usd"] == pytest.approx(50_000.0 - 10 * bought - 20 * sold, abs=0.005)

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
    assert later["account"]["buying_power_usd"] == start["buying_power_usd"]  # the cost of the positions does not move
    assert open_pnl != mid["account"]["open_pnl_usd"]  # the balance moved with nobody asking


# -- step and jump ------------------------------------------------------------------------------------------------


def test_step_and_jump_move_the_clock_forward_only_and_nothing_clamps_them_at_the_close(
    db_session, user_id, svc, wall
) -> None:
    thread_id, _, _ = _started(db_session, user_id, svc)
    assert _control(db_session, user_id, svc, thread_id, step="bar")["clock"] == _at("09:35")
    assert _control(db_session, user_id, svc, thread_id, to=_at("09:50").to_pydatetime())["clock"] == _at("09:50")
    assert _control(db_session, user_id, svc, thread_id, to=_at("09:40").to_pydatetime())["clock"] == _at("09:50")
    assert _control(db_session, user_id, svc, thread_id, to=_at("13:00").to_pydatetime())["clock"] == _at("13:00")
    assert _control(db_session, user_id, svc, thread_id, to=_at("17:00").to_pydatetime())["clock"] == _at("17:00")
    overnight = et(DAYS[1], "03:00")
    assert _control(db_session, user_id, svc, thread_id, to=overnight.to_pydatetime())["clock"] == overnight
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


def test_the_clock_needs_an_open_day(db_session, user_id, svc) -> None:
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


def test_skip_day_jumps_to_the_next_start_flattens_the_position_and_opens_the_next_day(
    db_session, user_id, svc, wall, world
) -> None:
    _bend(world, "GAPPER", "10:00", None, open=113.0, high=113.0, low=113.0, close=113.0)
    thread_id, row, gapper = _started(db_session, user_id, svc)
    bought = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)["mark"]["price"]
    _control(db_session, user_id, svc, thread_id, speed=5)

    ended, opened = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert ended.id == row.id and ended.status == "ended" and ended.revealed_through == _at("20:00")
    ledger = db_session.query(PracticeLedger).filter_by(thread_id=thread_id).all()
    pnl = round(10 * (113.0 - bought), 2)
    assert [(e.shares, float(e.exit_price), float(e.pnl_usd)) for e in ledger] == [(10, 113.0, pnl)]  # tape's end
    assert opened.day_list is not None and opened.day_list.id != row.id and opened.day_list.status == "listed"
    assert opened.day_list.day_no == 2 and opened.day_list.clock_speed == 5  # the speed she chose carries over
    out = _read(db_session, user_id, svc, thread_id)
    assert (out["state"], out["day_list_id"], out["clock"]) == ("paused", opened.day_list.id, et(DAYS[1], "09:30"))
    assert out["account"]["balance"] == 50_000.0 + pnl  # the new balance, from the ledger

    # A day she never started is a Pass: skip books nothing and opens the one after, the clock at its start.
    skipped, after = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert skipped.id == opened.day_list.id and skipped.status == "ended" and after.day_list.day_no == 3
    assert after.day_list.revealed_through == et(DAYS[2], "09:30")
    assert db_session.query(PracticeLedger).filter_by(thread_id=thread_id).count() == 1


def test_skip_day_keeps_a_running_clock_running_at_the_next_start(db_session, user_id, svc, wall) -> None:
    thread_id, row, _ = _started(db_session, user_id, svc)
    _control(db_session, user_id, svc, thread_id, running=True, speed=2)
    _, opened = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    db_session.commit()
    assert opened.day_list.clock_running is True and opened.day_list.clock_speed == 2
    wall[0] += timedelta(minutes=30)  # the new day's clock runs from its start, as the old one did
    assert _read(db_session, user_id, svc, thread_id)["clock"] == et(DAYS[1], "10:30")


def test_skip_day_ends_a_running_clock_with_a_flagged_stop(db_session, user_id, svc, wall, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=48.5)
    thread_id, row, _ = _started(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10, stopPrice=49.0)
    _control(db_session, user_id, svc, thread_id, running=True)
    ended, _ = clock_mod.skip_day(db_session, user_id, thread_id, svc)
    assert ended.status == "ended" and ended.clock_running is False and ended.revealed_through == _at("20:00")
    assert float(db_session.query(PracticeLedger).filter_by(thread_id=thread_id).one().exit_price) == 50.0
    assert DAYS[0] == row.day  # the stop crossed at 10:21 did not matter to the skip
