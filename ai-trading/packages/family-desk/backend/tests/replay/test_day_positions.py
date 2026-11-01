"""Several open practice positions in one day (the multi-position follow-up to the Practice Portfolio): N positions are
N names, each one average-cost position (`test_positions.py` covers many fills in one name). The day clock is shared,
the open trades are priced at it, a stop crossed on any open name pauses play, the max loss is one day rule over
realized plus open, and End day flattens every open trade at the clock. Real Postgres; the synthetic world of
`tests/daily_world.py`.

The world on 2026-09-28: GAPPER sits at 110 from the open to 11:30, FLAT at 50 all day, SPLITTER at 100 (it splits
after the third day). Tests bend a name's minute bars to make a stop cross or a position lose."""

import pandas as pd
import pytest
from daily_world import DAYS, make_thread
from test_replay_plan import _advance
from test_replay_switch import _mark, _names, _row

from ai_trading.core.calendar import et
from ai_trading.db.models import PracticeLedger, PracticeMark
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay.model import Mark, Plan, spans_of
from ai_trading.replay.session import ReplayProblem


def _at(hhmm: str) -> pd.Timestamp:
    return et(DAYS[0], hhmm)


def _extra_names(world, *symbols: str) -> None:
    """More names on the day's list: each trades like FLAT (the synthetic world only knows three symbols)."""
    for symbol in symbols:
        world.raw[symbol], world.split[symbol] = world.raw["FLAT"], world.split["FLAT"]
        world.minutes[symbol] = world.minutes["FLAT"].copy()


def _bend(world, symbol: str, start: str, end: str | None, **prices: float) -> None:
    """Set columns of `symbol`'s minute bars from `start` (inclusive) to `end` (exclusive, None: to the day's end)."""
    frame = world.minutes[symbol]
    day = frame.index.tz_convert("America/New_York").date == DAYS[0]
    rows = day & (frame.index >= _at(start)) & (True if end is None else frame.index < _at(end))
    for column, value in prices.items():
        frame.loc[rows, column] = value


def _enter(db_session, user_id, svc, row, symbol: str, kind: str = "long_entry", **extra):
    """Open (or resume) `symbol` and mark an entry on it, the way the Portfolio's row does."""
    started = plan_mod.start_session(db_session, user_id, row.id, symbol, svc)
    placed = _mark(db_session, user_id, svc, started.id, kind, **extra)
    return started, placed


def _sessions(db_session, user_id, svc, row) -> dict[str, dict]:
    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    return {s["symbol"]: s for s in out["sessions"]}


# -- N names, one position each ----------------------------------------------------------------------------------


def test_three_names_hold_open_trades_at_once(db_session, user_id, svc, world) -> None:
    _extra_names(world, "N1", "N2", "N3")
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT", "SPLITTER", "N1", "N2", "N3")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    _enter(db_session, user_id, svc, row, "FLAT", shares=5)  # switching with GAPPER open is no longer a 409
    _enter(db_session, user_id, svc, row, "SPLITTER", "short_entry", shares=5)

    held = _sessions(db_session, user_id, svc, row)
    assert [(s["has_open_trade"], s["position"]["side"]) for s in held.values()] == [
        (True, "long"),
        (True, "long"),
        (True, "short"),
    ]
    assert [s["position"]["last_price"] for s in held.values()] == [110.0, 50.0, 100.0]

    for symbol in ("N1", "N2"):
        _enter(db_session, user_id, svc, row, symbol, shares=1)
    assert sum(s["has_open_trade"] for s in _sessions(db_session, user_id, svc, row).values()) == 5

    sixth = plan_mod.start_session(db_session, user_id, row.id, "N3", svc)  # no cap on how many names are held
    _mark(db_session, user_id, svc, sixth.id, "long_entry", shares=1)
    assert sum(s["has_open_trade"] for s in _sessions(db_session, user_id, svc, row).values()) == 6
    _mark(db_session, user_id, svc, sixth.id, "long_exit")

    again = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=1)  # the same name adds to its position
    assert again["open_trade"]["shares"] == 6 and again["open_trade"]["trade_no"] == 1

    _mark(db_session, user_id, svc, gapper.id, "long_exit")
    assert _mark(db_session, user_id, svc, sixth.id, "long_entry", shares=1)["mark"]["kind"] == "long_entry"


# -- buying power is the only size rule -------------------------------------------------------------------------------


def test_a_day_entry_is_refused_only_when_it_costs_more_than_the_balance_less_the_open_trades(
    db_session, user_id, svc, world
) -> None:
    make_thread(db_session, user_id, starting_balance=1_000)
    row, gapper = _names(db_session, user_id, svc, "FLAT", "SPLITTER")  # GAPPER 110, FLAT 50, SPLITTER 100
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    with pytest.raises(ReplayProblem) as broke:  # 10 * 110 = 1,100 > 1,000
        _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=10)
    assert (broke.value.message, broke.value.path, broke.value.status) == (
        "Not enough practice cash · $1,000 free",
        "shares",
        422,
    )
    assert session_mod._load_marks(db_session, gapper.id) == []  # nothing was written
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)  # 550 of 1,000
    with pytest.raises(ReplayProblem) as rest:  # FLAT costs 50 a share: 450 left buys 9, not 10
        _enter(db_session, user_id, svc, row, "FLAT", shares=10)
    assert rest.value.message == "Not enough practice cash · $450 free"
    _enter(db_session, user_id, svc, row, "FLAT", shares=9)  # exactly the 450 left: allowed
    with pytest.raises(ReplayProblem) as short_too:  # a short counts like a long
        _enter(db_session, user_id, svc, row, "SPLITTER", "short_entry", shares=1)
    assert short_too.value.message == "Not enough practice cash · $0 free"


def test_a_realized_trade_changes_the_buying_power_and_a_stop_is_never_needed(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, starting_balance=1_000, stopNoteOnEntry="yes")
    _, session = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, session.id, "09:35")
    placed = _mark(db_session, user_id, svc, session.id, "long_entry", shares=9)  # 990 of 1,000; no stop: accepted
    assert placed["open_trade"]["stop_price"] is None
    _mark(db_session, user_id, svc, session.id, "long_exit")  # flat again; the ledger credits the (zero) P/L
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=9)  # the cash is back


# -- the stop pause over every open name ----------------------------------------------------------------------------


def test_advance_pauses_at_first_stop_crossing_of_any_open_name(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=48.5)  # crosses a stop at 49 in the 10:20 bar
    _bend(world, "SPLITTER", "10:40", "10:41", low=98.0)  # crosses a stop at 99 in the 10:40 bar
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT", "SPLITTER")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)  # no stop: never pauses
    flat, _ = _enter(db_session, user_id, svc, row, "FLAT", shares=10, stopPrice=49.0)
    splitter, _ = _enter(db_session, user_id, svc, row, "SPLITTER", shares=10, stopPrice=99.0)

    # She is on SPLITTER; FLAT's stop is the first one crossed, so play stops at the close of its 10:20 bar.
    first = _advance(db_session, user_id, svc, splitter.id, "11:00")
    assert first["paused"] == {
        "symbol": "FLAT",
        "stop_price": 49.0,
        "at": _at("10:21"),
        "price": 50.0,
        "kind": "cross",
        "also": [],
    }
    assert first["revealed_through"] == _at("10:21")
    assert plan_mod.get_day_list(db_session, user_id, row.id).revealed_through == _at("10:21")  # the day clock
    assert _row(db_session, flat.id).stop_hit_at == _at("10:21") and _row(db_session, splitter.id).stop_hit_at is None
    held = _sessions(db_session, user_id, svc, row)
    assert held["FLAT"]["position"]["stop_hit_at"] == _at("10:21")
    assert "stop_hit_at" not in {k for k, v in held["SPLITTER"]["position"].items() if v is not None}

    # She exits from the toast: the name is resumed (lifted to the clock) and exited, which clears the flag.
    exited = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    assert exited.revealed_through == _at("10:21")
    _mark(db_session, user_id, svc, flat.id, "long_exit")
    assert _row(db_session, flat.id).stop_hit_at is None

    # The name she is on pauses on its own stop too, and a flagged stop never pauses twice.
    second = _advance(db_session, user_id, svc, splitter.id, "11:00")
    assert second["paused"]["symbol"] == "SPLITTER" and second["paused"]["at"] == _at("10:41")
    assert second["revealed_through"] == _at("10:41")
    third = _advance(db_session, user_id, svc, splitter.id, "11:00")
    assert third["paused"] is None and third["revealed_through"] == _at("11:00")


# -- End day flattens every open trade ------------------------------------------------------------------------------


def test_end_day_flattens_every_open_trade_at_the_clock(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:00", "10:30", open=52.0, high=52.0, low=52.0, close=52.0)
    _bend(world, "FLAT", "10:30", None, open=55.0, high=55.0, low=55.0, close=55.0)
    _bend(world, "SPLITTER", "10:00", None, open=101.0, high=101.0, low=101.0, close=101.0)
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT", "SPLITTER")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    flat, _ = _enter(db_session, user_id, svc, row, "FLAT", shares=10)
    splitter, _ = _enter(db_session, user_id, svc, row, "SPLITTER", "short_entry", shares=4)
    _advance(db_session, user_id, svc, flat.id, "10:10")  # the clock: GAPPER and SPLITTER are behind it

    plan_mod.end_day(db_session, user_id, row.id, svc)

    exits = {}
    for s in (gapper, flat, splitter):
        mark = max(session_mod._marks_of(session_mod._load_marks(db_session, s.id)), key=lambda m: m.seq)
        exits[s.symbol] = (mark.kind, mark.source, mark.at, mark.price)
    assert exits == {
        "GAPPER": ("long_exit", "auto", _at("10:10"), 110.0),
        "FLAT": ("long_exit", "auto", _at("10:10"), 52.0),  # not the 55.0 of the window end
        "SPLITTER": ("short_exit", "auto", _at("10:10"), 101.0),
    }
    ledger = db_session.query(PracticeLedger).filter_by(thread_id=gapper.thread_id).all()
    assert sorted((r.symbol, float(r.pnl_usd)) for r in ledger) == [("FLAT", 20.0), ("GAPPER", 0.0), ("SPLITTER", -4.0)]
    day = plan_mod.get_day_list(db_session, user_id, row.id)
    assert day.status == "ended" and day.revealed_through == _at("11:30")  # the window unseals after the flatten
    assert day.journal["trades"] == 3 and day.journal["pnl_usd"] == 16.0
    assert (day.journal["wins"], day.journal["losses"], day.journal["scratches"]) == (1, 1, 1)


def test_end_day_exits_a_lone_trade_at_the_clock_not_the_window_end(db_session, user_id, svc, world) -> None:
    _bend(world, "GAPPER", "10:30", "11:30", open=120.0, high=120.0, low=120.0, close=120.0)
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc)
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    _advance(db_session, user_id, svc, gapper.id, "10:10")

    plan_mod.end_day(db_session, user_id, row.id, svc)

    exit_mark = max(session_mod._marks_of(session_mod._load_marks(db_session, gapper.id)), key=lambda m: m.seq)
    assert (exit_mark.source, exit_mark.at, exit_mark.price) == ("auto", _at("10:10"), 110.0)  # not 120.0 at 11:30
    assert _row(db_session, gapper.id).journal["totals"]["pnl_usd"] == 0.0


# -- the shared day budget -----------------------------------------------------------------------------------------


def test_max_loss_counts_open_positions_at_entry(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:00", None, open=48.0, high=48.0, low=48.0, close=48.0)
    make_thread(db_session, user_id, maxLossUsd=100)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    flat, _ = _enter(db_session, user_id, svc, row, "FLAT", shares=100)  # day P/L 0 at this entry
    _advance(db_session, user_id, svc, flat.id, "10:05")  # FLAT is 2 under its entry on 100 shares: -$200 open
    entered, _ = _enter(db_session, user_id, svc, row, "GAPPER", shares=5)  # not refused: scored
    assert entered.id == gapper.id and _row(db_session, gapper.id).revealed_through == _at("10:05")
    _advance(db_session, user_id, svc, gapper.id, "10:20")
    _mark(db_session, user_id, svc, gapper.id, "long_exit")
    plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)  # FLAT exits after GAPPER's entry: realized only
    _mark(db_session, user_id, svc, flat.id, "long_exit")  # then would not have counted at GAPPER's entry

    snapshots = {
        s.symbol: float(db_session.query(PracticeMark).filter_by(session_id=s.id, kind="long_entry").one().day_pnl_usd)
        for s in (flat, gapper)
    }
    assert snapshots == {"FLAT": 0.0, "GAPPER": -200.0}

    plan_mod.end_day(db_session, user_id, row.id, svc)
    for s in (flat, gapper):  # the rule is a day rule: both names' journals carry it
        check = {c["id"]: c for c in _row(db_session, s.id).journal["adherence"]["checks"]}["max_loss"]
        assert (check["passed"], check["detail"]) == (False, "1 of 2")


def test_max_loss_falls_back_to_realized_only_for_a_mark_without_a_snapshot() -> None:
    open_ = pd.Timestamp("2026-10-23T13:30:00Z")
    index = pd.date_range(open_, periods=60, freq="1min")
    bars = pd.DataFrame({"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1.0}, index=index)

    def journal(snapshot: float | None):
        marks = [
            Mark(1, "long_entry", open_ + pd.Timedelta(minutes=10), 100.0, 10, trade_no=1, day_pnl_usd=snapshot),
            Mark(2, "long_exit", open_ + pd.Timedelta(minutes=20), 100.0, trade_no=1),
        ]
        return journal_mod.compute_journal(
            marks,
            bars=bars,
            fires=[],
            plan=Plan(max_loss_usd=100),
            display_minutes=5,
            window_start=open_,
            window_end=open_ + pd.Timedelta(minutes=60),
            as_of=open_ + pd.Timedelta(minutes=60),
            last_price=100.0,
            final=True,
        )

    def check(out):
        return next(c for c in out["adherence"]["checks"] if c["id"] == "max_loss")

    assert check(journal(None))["passed"] is True  # no snapshot: no realized loss before the entry
    assert check(journal(-100.0))["passed"] is False  # the day was at -$100 (realized + open) when she entered
    assert check(journal(-99.99))["passed"] is True


# -- the day's portfolio figures ------------------------------------------------------------------------------------


def test_the_day_list_prices_every_position_at_the_clock_and_totals_the_day(db_session, user_id, svc, world) -> None:
    _bend(world, "GAPPER", "10:00", None, open=120.0, high=120.0, low=120.0, close=120.0)
    _bend(world, "FLAT", "10:00", None, open=52.0, high=52.0, low=52.0, close=52.0)
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    flat, _ = _enter(db_session, user_id, svc, row, "FLAT", shares=10)
    _advance(db_session, user_id, svc, flat.id, "10:10")

    out = plan_mod.day_list_out(db_session, user_id, row.id, svc)
    behind = next(s for s in out["sessions"] if s["symbol"] == "GAPPER")
    assert behind["behind_clock"] is True and behind["revealed_through"] == _at("09:35")
    assert (behind["position"]["last_price"], behind["position"]["unrealized_usd"]) == (120.0, 50.0)  # at the clock
    # The Portfolio shows when each trade was entered and orders the open trades by it.
    assert behind["position"]["entry_at"] == _at("09:35")
    entered = next(s for s in out["sessions"] if s["symbol"] == "FLAT")["position"]["entry_at"]
    assert entered == _at("09:35")  # FLAT was entered at the clock GAPPER had reached
    assert out["day_pnl"] == {
        "realized_usd": 0.0,
        "open_usd": 70.0,
        "total_usd": 70.0,
        "open_count": 2,
        "as_of": _at("10:10"),
    }

    _mark(db_session, user_id, svc, flat.id, "long_exit")  # FLAT books +$20 at 52
    after = plan_mod.day_list_out(db_session, user_id, row.id, svc)["day_pnl"]
    assert (after["realized_usd"], after["open_usd"], after["total_usd"], after["open_count"]) == (20.0, 50.0, 70.0, 1)


def test_resuming_a_name_behind_the_clock_lifts_it_to_the_clock_and_adds_the_away_span(
    db_session, user_id, svc
) -> None:
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    _advance(db_session, user_id, svc, flat.id, "10:00")
    assert _row(db_session, gapper.id).revealed_through == _at("09:35")

    resumed = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)

    assert resumed.id == gapper.id and resumed.revealed_through == _at("10:00")
    assert spans_of(resumed.away) == [(_at("09:35"), _at("10:00"))]
    assert _mark(db_session, user_id, svc, gapper.id, "long_exit")["mark"]["at"] == _at("10:00")  # markable at once


def test_a_mark_cannot_be_undone_once_another_name_has_moved_the_day_clock(db_session, user_id, svc) -> None:
    """The Portfolio prices every position at the clock, so an entry on a name she has left would otherwise be undone
    after she had seen where it went (no peeking, then undoing)."""
    make_thread(db_session, user_id)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    entry = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)["mark"]["id"]
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    undone = session_mod.undo_mark(db_session, user_id, gapper.id, entry, svc)  # the clock has not moved yet
    assert undone["removed_mark_id"] == entry and undone["open_trade"] is None
    entry = _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)["mark"]["id"]
    _advance(db_session, user_id, svc, flat.id, "10:00")  # FLAT moves the clock past GAPPER's entry
    with pytest.raises(ReplayProblem) as sealed:
        session_mod.undo_mark(db_session, user_id, gapper.id, entry, svc)
    assert sealed.value.status == 409
