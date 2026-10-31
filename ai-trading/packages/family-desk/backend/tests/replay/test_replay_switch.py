"""Switching names on the shared day clock (02o-b2): the reveal rules (nothing past the clock, what a name did while
she was elsewhere is shown as history and not scored), the catch-up, the place_mark guards, one open trade a day, and
no cap on the names a day opens (an old plan's `maxSymbols` is ignored). Real Postgres; the synthetic world of
`tests/daily_world.py`.

The world: GAPPER sits at 106 in the premarket and 110 from the open; FLAT sits at 50 all day. The day list holds GAPPER
only, so the tests add FLAT and SPLITTER to its candidates the way the v1 tests do."""

import pandas as pd
import pytest
from daily_world import DAYS, make_thread
from test_replay_plan import _advance, _first_list, _open, _plan

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticePlan, ReplaySession
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import signals as signals_mod
from ai_trading.replay.model import Fire, Mark, Plan, add_span, spans_of, unseen
from ai_trading.replay.session import ReplayProblem


def _mark(db_session, user_id, svc, session_id, kind, **extra):
    return session_mod.place_mark(db_session, user_id, session_id, svc, {"schemaVersion": 1, "kind": kind, **extra})


def _names(db_session, user_id, svc, *extra, **plan):
    """A first list on the three synthetic names, with GAPPER practised from the open. `extra` adds list names."""
    if plan:
        plan_mod.run_prep(db_session, svc, _plan(db_session, user_id, svc, **plan).id)
        row = _open(db_session, user_id, svc).day_list
    else:
        row = _first_list(db_session, user_id, svc)
    for symbol in extra:
        row.candidates = [*row.candidates, {**row.candidates[0], "symbol": symbol, "rank": len(row.candidates) + 1}]
    db_session.commit()
    started = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    return row, started


def _fire(hhmm: str, name: str = "X") -> Fire:
    close = et(DAYS[0], hhmm)
    return Fire("alert_strategy", 1, name, None, close - pd.Timedelta(minutes=5), close, 50.0)


def _feed(db_session, user_id, svc, session_id):
    return session_mod.feed(db_session, user_id, session_id, svc, interval=None)


def _row(db_session, session_id) -> ReplaySession:
    row = db_session.get(ReplaySession, session_id)
    db_session.refresh(row)
    return row


# -- the pure span helpers -----------------------------------------------------------------------------------


def test_a_span_joins_the_one_it_continues_and_a_fire_at_its_edges_is_seen() -> None:
    start, mid, end = et(DAYS[0], "09:30"), et(DAYS[0], "10:00"), et(DAYS[0], "10:30")
    rows = add_span(add_span([], start, mid), mid, end)
    assert len(rows) == 1 and spans_of(rows) == [(start, end)]
    assert add_span([], mid, mid) == [] and add_span(rows, end, start) == rows
    spans = spans_of(rows)
    assert unseen(spans, et(DAYS[0], "10:15")) and not unseen(spans, start) and not unseen(spans, end)
    assert not unseen(spans, et(DAYS[0], "10:31")) and not unseen([], mid)


def test_the_on_signal_check_ignores_a_fire_from_a_span_she_was_away_for() -> None:
    open_ = pd.Timestamp("2026-10-23T13:30:00Z")
    index = pd.date_range(open_, periods=60, freq="1min")
    bars = pd.DataFrame({"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1.0}, index=index)
    marks = [
        Mark(1, "long_entry", open_ + pd.Timedelta(minutes=12), 100.0, 10, trade_no=1),
        Mark(2, "long_exit", open_ + pd.Timedelta(minutes=20), 100.0, trade_no=1),
    ]
    fire = Fire(
        "alert_strategy", 1, "X", None, open_ + pd.Timedelta(minutes=5), open_ + pd.Timedelta(minutes=10), 100.0
    )

    def journal(away):
        return journal_mod.compute_journal(
            marks,
            bars=bars,
            fires=[fire],
            plan=Plan(signal_only=True),
            display_minutes=5,
            window_start=open_,
            window_end=open_ + pd.Timedelta(minutes=60),
            as_of=open_ + pd.Timedelta(minutes=60),
            last_price=100.0,
            final=True,
            away=away,
        )

    watched = journal([])
    assert watched["trades"][0]["on_signal"] is True and watched["adherence"]["score_pct"] == 100
    away = journal([(open_, open_ + pd.Timedelta(minutes=11))])
    assert away["trades"][0]["on_signal"] is False and away["adherence"]["score_pct"] == 0
    assert watched["signals_vs_trades"][0]["her"] == "entered 2 min later"
    assert away["signals_vs_trades"][0]["her"] == "you were on another name"  # the table lists it, and says why


# -- the reveal rules ----------------------------------------------------------------------------------------


def test_a_name_switched_to_at_ten_opens_on_the_clock_and_never_past_it(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "10:00")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert flat.revealed_through == et(DAYS[0], "10:00")  # the clock, not the window start
    assert spans_of(flat.away) == [(et(DAYS[0], "09:30"), et(DAYS[0], "10:00"))]
    frame = _feed(db_session, user_id, svc, flat.id)
    assert frame["revealed_through"] == et(DAYS[0], "10:00") and frame["behind_clock"] is False
    assert max(bar["t"] for bar in frame["bars"]) + pd.Timedelta(minutes=5) <= et(DAYS[0], "10:00")
    assert gapper.away == []  # the first name was watched from the open
    strip = plan_mod.day_list_out(db_session, user_id, row.id, svc)["sessions"]
    assert [(s["symbol"], s["behind_clock"], s["has_open_trade"]) for s in strip] == [
        ("GAPPER", False, False),
        ("FLAT", False, False),
    ]


def test_a_signal_that_fired_before_the_switch_is_history_not_a_chance(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, tradeOnlyOnSignal="yes")
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "10:00")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    flat.signals = signals_mod.dump_fires([_fire("09:55"), _fire("10:10")])
    db_session.commit()
    shown = _feed(db_session, user_id, svc, flat.id)["signals"]
    assert [(s["bar_close"], s["seen"]) for s in shown] == [(et(DAYS[0], "09:55"), False)]  # shown, and marked
    ahead = _advance(db_session, user_id, svc, flat.id, "10:15")
    assert [(s["bar_close"], s["seen"]) for s in ahead["signals"]] == [(et(DAYS[0], "10:10"), True)]
    _advance(db_session, user_id, svc, flat.id, "10:20")  # still no mark of hers: enters at 10:20, 10 min after 10:10
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)
    _mark(db_session, user_id, svc, flat.id, "long_exit")
    out = session_mod.session_out(session_mod.context(db_session, svc, _row(db_session, flat.id)))
    checks = {c["id"]: c for c in out["journal"]["adherence"]["checks"]}
    assert checks["on_signal"]["detail"] == "1 of 1"  # the 10:10 fire counts, the 09:55 one never did


def test_a_fire_before_the_switch_does_not_make_an_entry_a_signal_entry(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, tradeOnlyOnSignal="yes")
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "10:00")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    flat.signals = signals_mod.dump_fires([_fire("09:55")])  # 5 minutes before she arrived
    db_session.commit()
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)
    _mark(db_session, user_id, svc, flat.id, "long_exit")
    plan_mod.end_day(db_session, user_id, row.id, svc)
    journal = _row(db_session, flat.id).journal
    checks = {c["id"]: c for c in journal["adherence"]["checks"]}
    assert checks["on_signal"]["passed"] is False and checks["on_signal"]["detail"] == "0 of 1"
    assert journal["signals_vs_trades"][0]["her"] == "you were on another name"


# -- the catch-up --------------------------------------------------------------------------------------------


def test_a_name_left_behind_catches_up_to_the_clock_and_cannot_be_marked_before(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "10:00")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _advance(db_session, user_id, svc, flat.id, "10:30")  # the clock moves while she is on FLAT
    db_session.refresh(row)
    assert row.revealed_through == et(DAYS[0], "10:30")
    gapper.signals = signals_mod.dump_fires([_fire("10:20", "mid"), _fire("10:45", "later")])
    db_session.commit()
    behind = _feed(db_session, user_id, svc, gapper.id)
    assert behind["behind_clock"] is True and behind["day_clock"] == et(DAYS[0], "10:30")
    assert behind["revealed_through"] == et(DAYS[0], "10:00") and behind["signals"] == []  # nothing past her playhead
    assert session_mod.session_out(session_mod.context(db_session, svc, _row(db_session, gapper.id)))["behind_clock"]
    assert [s["behind_clock"] for s in plan_mod.day_list_out(db_session, user_id, row.id, svc)["sessions"]] == [
        True,
        False,
    ]
    with pytest.raises(ReplayProblem) as caught:
        _mark(db_session, user_id, svc, gapper.id, "note")  # even a note: the mark would be stamped in the past
    assert caught.value.message == "This name is behind the day clock · advance to catch up before you mark"
    caught_up = _advance(db_session, user_id, svc, gapper.id, "10:05")  # asks for less than the clock: monotonic
    assert caught_up["revealed_through"] == et(DAYS[0], "10:30") and caught_up["behind_clock"] is False
    assert [(s["name"], s["seen"]) for s in caught_up["signals"]] == [("mid", False)]  # fired while she was away
    assert spans_of(_row(db_session, gapper.id).away) == [(et(DAYS[0], "10:00"), et(DAYS[0], "10:30"))]
    placed = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=1)
    assert placed["mark"]["at"] == et(DAYS[0], "10:30") and placed["mark"]["price"] == 110.0
    later = _advance(db_session, user_id, svc, gapper.id, "10:50")
    assert [(s["name"], s["seen"]) for s in later["signals"]] == [("later", True)]


def test_a_catch_up_past_the_ask_still_moves_the_clock_only_forward(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _advance(db_session, user_id, svc, flat.id, "10:30")
    again = _advance(db_session, user_id, svc, gapper.id, "11:00")  # asks past the clock: the clock follows
    assert again["revealed_through"] == et(DAYS[0], "11:00")
    db_session.refresh(row)
    assert row.revealed_through == et(DAYS[0], "11:00")
    assert spans_of(_row(db_session, gapper.id).away) == [(et(DAYS[0], "09:30"), et(DAYS[0], "10:30"))]
    back = _advance(db_session, user_id, svc, flat.id, "10:35")  # FLAT is now behind the 11:00 clock
    assert back["revealed_through"] == et(DAYS[0], "11:00")
    db_session.refresh(row)
    assert row.revealed_through == et(DAYS[0], "11:00")  # the clock never goes back


# -- one open trade a day ------------------------------------------------------------------------------------


def test_a_switch_with_a_trade_open_is_refused_until_the_trade_is_closed(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    assert plan_mod.day_list_out(db_session, user_id, row.id, svc)["sessions"][0]["has_open_trade"] is True
    with pytest.raises(ReplayProblem) as caught:
        plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert caught.value.status == 409 and caught.value.path == "symbol"
    assert caught.value.message.startswith("Close your open GAPPER practice trade before you switch to FLAT")
    assert plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc).id == gapper.id  # resuming it is fine
    _mark(db_session, user_id, svc, gapper.id, "long_exit")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)
    with pytest.raises(ReplayProblem) as entry:
        _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=1)  # not through the route either
    assert entry.value.message == "Close your open FLAT practice trade first · one open trade a day"
    _mark(db_session, user_id, svc, gapper.id, "note", note="watching")  # a note is not an entry


# -- no cap on names -----------------------------------------------------------------------------------------


def test_a_day_opens_every_list_name_without_a_cap(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    # a plan saved before the cap went away still carries `maxSymbols`: it is accepted and ignored
    row, _ = _names(db_session, user_id, svc, "FLAT", "SPLITTER", maxSymbols=1)
    assert db_session.get(PracticePlan, row.plan_id).spec["maxSymbols"] == 1
    for symbol in ("FLAT", "SPLITTER"):
        assert plan_mod.start_session(db_session, user_id, row.id, symbol, svc).day_list_id == row.id
    assert {s.symbol for s in db_session.query(ReplaySession).filter_by(day_list_id=row.id)} == {
        "GAPPER",
        "FLAT",
        "SPLITTER",
    }


def test_the_plan_no_longer_reports_a_name_cap(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id)
    row, _ = _names(db_session, user_id, svc)
    assert "max_symbols" not in plan_mod.plan_out(db_session, db_session.get(PracticePlan, row.plan_id))


def test_the_star_cap_is_the_watch_cap_and_not_the_plans(db_session, user_id, svc) -> None:
    """Stars still serve the swing focus names: twenty at most, whatever an old plan's `maxSymbols` says."""
    make_thread(db_session, user_id)
    extra = [f"N{i}" for i in range(20)]
    row, _ = _names(db_session, user_id, svc, *extra, maxSymbols=2)
    names = ["GAPPER", *extra]

    def star(symbols):
        return plan_mod.patch_day_list(
            db_session, user_id, row.id, svc, watch=symbols, notes=None, rating=None, fields={"watch"}
        )

    assert len(star(names[:20]).watch) == 20
    with pytest.raises(ReplayProblem) as caught:
        star(names)
    assert caught.value.path == "watch" and caught.value.message == "Star at most 20 names"
