"""One average-cost position per name, any number of fills (ADR-0016, "One position per name, many fills"): scale in,
sell part, flip, and buying power as the only size rule. The first half is the pure walk (`journal.assemble`); the
second half runs a day session on real Postgres over the synthetic world of `tests/daily_world.py` (FLAT sits at 50
all day, GAPPER at 110; a test bends FLAT's bars to give the fills different prices)."""

import pandas as pd
import pytest
from daily_world import make_thread
from test_day_positions import _at, _bend, _enter
from test_replay_plan import _advance
from test_replay_switch import _mark, _names

from ai_trading.db.models import PracticeLedger, PracticeMark
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.model import Mark, Plan
from ai_trading.replay.session import ReplayProblem

T0 = pd.Timestamp("2026-10-23T13:30:00Z")


def _m(seq: int, kind: str, minute: int, price: float | None, shares: int | None = None, **extra) -> Mark:
    return Mark(seq, kind, T0 + pd.Timedelta(minutes=minute), price, shares, id=seq, **extra)  # type: ignore[arg-type]


# -- the pure walk ---------------------------------------------------------------------------------------------------


def test_a_second_buy_averages_the_cost_and_the_exit_realizes_it_cent_exact() -> None:
    closed, open_ = journal_mod.assemble([_m(1, "long_entry", 1, 50.0, 10), _m(2, "long_entry", 5, 52.0, 20)])
    assert closed == [] and open_ is not None
    assert (open_.side, open_.shares, open_.entry_price, open_.no) == ("long", 30, 51.333333, 1)
    assert open_.entry_at == T0 + pd.Timedelta(minutes=1)  # the position opened with its first fill

    closed, open_ = journal_mod.assemble(
        [_m(1, "long_entry", 1, 50.0, 10), _m(2, "long_entry", 5, 52.0, 20), _m(3, "long_exit", 9, 52.0)]
    )
    assert open_ is None and len(closed) == 1
    assert journal_mod.trade_pnl(closed[0]) == 20.0  # 10 * (52 - 50) + 20 * (52 - 52): the dollars the fills made


def test_the_average_cost_is_carried_to_six_decimals_halves_up() -> None:
    assert journal_mod.average_cost(1, 10.0, 2, 10.01) == 10.006667
    assert journal_mod.average_cost(2, 1.0, 1, 1.000001) == 1.000000  # 1.0000003333 rounds down
    assert journal_mod.average_cost(1, 1.0, 1, 1.000001) == 1.000001  # 1.0000005 rounds up (halves up)


def test_selling_part_of_a_long_realizes_a_slice_at_the_average_cost_and_keeps_the_cost() -> None:
    marks = [
        _m(1, "long_entry", 1, 50.0, 10),
        _m(2, "long_entry", 5, 52.0, 20),
        _m(3, "short_entry", 9, 53.0, 12),
    ]
    closed, open_ = journal_mod.assemble(marks)
    (sold,) = closed
    assert (sold.side, sold.shares, sold.entry_price, sold.exit_price, sold.exit_mark_id) == (
        "long", 12, 51.333333, 53.0, 3
    )  # fmt: skip
    assert journal_mod.trade_pnl(sold) == 20.0  # 12 * (53 - 51.333333) = 20.000004
    assert open_ is not None and (open_.shares, open_.entry_price) == (18, 51.333333)  # the cost never moves on a sale
    closed, open_ = journal_mod.assemble([*marks, _m(4, "long_exit", 12, 54.0)])
    assert [t.shares for t in closed] == [12, 18] and open_ is None
    assert journal_mod.trade_pnl(closed[1]) == 48.0  # 18 * (54 - 51.333333) = 48.000006
    assert journal_mod.usd_sum([journal_mod.trade_pnl(t) for t in closed]) == 68.0  # 1,608 sold less the 1,540 paid


def test_a_sale_larger_than_the_position_flips_it_to_a_short_with_the_rest() -> None:
    closed, open_ = journal_mod.assemble([_m(1, "long_entry", 1, 50.0, 10), _m(2, "short_entry", 5, 51.0, 25)])
    (sold,) = closed
    assert (sold.side, sold.shares, journal_mod.trade_pnl(sold), sold.no) == ("long", 10, 10.0, 1)
    assert open_ is not None
    assert (open_.side, open_.shares, open_.entry_price, open_.no) == ("short", 15, 51.0, 2)
    assert open_.entry_at == T0 + pd.Timedelta(minutes=5) and open_.stop_price is None  # a new position, no old stop
    closed, open_ = journal_mod.assemble(
        [_m(1, "long_entry", 1, 50.0, 10), _m(2, "short_entry", 5, 51.0, 25), _m(3, "long_entry", 9, 49.0, 15)]
    )
    assert open_ is None and [(t.side, t.shares, journal_mod.trade_pnl(t)) for t in closed] == [
        ("long", 10, 10.0),
        ("short", 15, 30.0),
    ]


def test_selling_exactly_the_position_closes_it_and_a_short_is_covered_the_same_way() -> None:
    closed, open_ = journal_mod.assemble([_m(1, "long_entry", 1, 50.0, 10), _m(2, "short_entry", 5, 51.0, 10)])
    assert open_ is None and len(closed) == 1 and journal_mod.trade_pnl(closed[0]) == 10.0
    closed, open_ = journal_mod.assemble([_m(1, "short_entry", 1, 50.0, 10), _m(2, "long_entry", 5, 49.0, 4)])
    assert (journal_mod.trade_pnl(closed[0]), closed[0].side) == (4.0, "short")  # 4 * (50 - 49)
    assert open_ is not None and (open_.side, open_.shares, open_.entry_price) == ("short", 6, 50.0)


def test_the_stop_belongs_to_the_position_and_r_is_measured_from_the_average_cost() -> None:
    marks = [
        _m(1, "long_entry", 1, 10.0, 100),
        _m(2, "stop", 2, None, stop_price=9.0),
        _m(3, "long_entry", 5, 11.0, 100),
        _m(4, "short_entry", 9, 12.0, 100),
    ]
    closed, open_ = journal_mod.assemble(marks)
    (sold,) = closed
    assert sold.stop_price == 9.0 and sold.entry_price == 10.5
    assert journal_mod.trade_pnl(sold) == 150.0 and sold.r_of(12.0) == 1.0  # (12 - 10.5) / (10.5 - 9)
    assert open_ is not None and open_.stop_price == 9.0 and open_.stops == [(T0 + pd.Timedelta(minutes=2), 9.0)]


def test_every_fill_that_adds_to_a_position_is_an_entry_for_the_max_loss_rule() -> None:
    bars = pd.DataFrame(
        {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1.0},
        index=pd.date_range(T0, periods=60, freq="1min"),
    )
    marks = [
        _m(1, "long_entry", 1, 100.0, 10, day_pnl_usd=0.0),
        _m(2, "long_entry", 5, 100.0, 10, day_pnl_usd=-150.0),  # added after the day was already down $150
        _m(3, "long_exit", 9, 100.0),
    ]
    out = journal_mod.compute_journal(
        marks,
        bars=bars,
        fires=[],
        plan=Plan(max_loss_usd=100),
        display_minutes=5,
        window_start=T0,
        window_end=T0 + pd.Timedelta(minutes=60),
        as_of=T0 + pd.Timedelta(minutes=60),
        last_price=100.0,
        final=True,
    )
    check = next(c for c in out["adherence"]["checks"] if c["id"] == "max_loss")
    assert (check["passed"], check["detail"]) == (False, "1 of 2")  # the first fill was fine, the add was not
    assert out["totals"]["trades"] == 1


def test_the_pnl_series_prices_each_minute_with_the_position_the_marks_had_built_by_then() -> None:
    bars = pd.DataFrame(
        {"open": 100.0, "high": 200.0, "low": 50.0, "close": [100.0 + i for i in range(30)], "volume": 1.0},
        index=pd.date_range(T0, periods=30, freq="1min"),
    )
    marks = [_m(1, "long_entry", 1, 101.0, 10), _m(2, "long_entry", 5, 105.0, 20), _m(3, "long_exit", 9, 109.0)]
    out = journal_mod.compute_journal(
        marks,
        bars=bars,
        fires=[],
        plan=Plan(),
        display_minutes=5,
        window_start=T0,
        window_end=T0 + pd.Timedelta(minutes=30),
        as_of=T0 + pd.Timedelta(minutes=30),
        last_price=129.0,
        final=True,
    )
    at = {point["t"]: point["pnl_usd"] for point in out["pnl_series"]}
    minute = lambda n: T0 + pd.Timedelta(minutes=n)  # noqa: E731 -- a one-line clock for the table below
    assert at[minute(0)] == 0.0
    assert (
        at[minute(3)] == 10.0
    )  # only the first 10 shares existed: 10 * (102 - 101), not 30 shares of the later average
    assert at[minute(5)] == 10.0  # the add lands at 5: 30 * (104 - 103.666667)
    assert at[minute(10)] == 160.0 and at[minute(30)] == 160.0  # 30 * (109 - 103.666667), realized for good


# -- a day session -----------------------------------------------------------------------------------------------------


def _flat(db_session, user_id, svc, *, balance=50_000):
    """FLAT's session at 09:35 on a list that also has GAPPER, on a thread holding `balance`."""
    make_thread(db_session, user_id, starting_balance=balance)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    return row, flat


def _ledger(db_session, session_id) -> list[tuple[int, float]]:
    db_session.expire_all()
    rows = db_session.query(PracticeLedger).filter_by(session_id=session_id).order_by(PracticeLedger.id).all()
    return [(r.shares, float(r.pnl_usd)) for r in rows]


def test_two_buys_of_one_name_make_one_position_at_the_average_cost(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "09:40", None, open=52.0, high=52.0, low=52.0, close=52.0)
    _, flat = _flat(db_session, user_id, svc)
    first = _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)  # at 50
    assert first["open_trade"]["shares"] == 10 and first["open_trade"]["entry_price"] == 50.0
    _advance(db_session, user_id, svc, flat.id, "09:45")
    second = _mark(db_session, user_id, svc, flat.id, "long_entry", shares=20)  # at 52: a scale-in, not a refusal
    trade = second["open_trade"]
    assert (trade["trade_no"], trade["shares"], trade["entry_price"]) == (1, 30, 51.333333)
    assert trade["entry_at"] == _at("09:35")  # the position's first fill
    assert trade["unrealized_usd"] == 20.0  # 30 * (52 - 51.333333) = 20.00001 to the cent
    assert second["mark"]["trade_no"] == 1 and second["journal"]["totals"]["trades"] == 0

    out = _mark(db_session, user_id, svc, flat.id, "long_exit")
    assert out["open_trade"] is None
    assert out["journal"]["totals"]["pnl_usd"] == 20.0 and out["journal"]["totals"]["trades"] == 1
    assert out["journal"]["trades"][0]["entry_price"] == 51.333333 and out["journal"]["trades"][0]["shares"] == 30
    assert _ledger(db_session, flat.id) == [(30, 20.0)]  # the ledger carries the journal's own figure


def test_selling_part_books_a_slice_now_and_leaves_the_rest_open(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "09:40", None, open=52.0, high=52.0, low=52.0, close=52.0)
    row, flat = _flat(db_session, user_id, svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, flat.id, "09:45")
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=20)
    sold = _mark(db_session, user_id, svc, flat.id, "short_entry", shares=12)  # fewer than all 30: a partial exit
    assert sold["open_trade"]["shares"] == 18 and sold["open_trade"]["entry_price"] == 51.333333
    assert sold["journal"]["totals"]["pnl_usd"] == 8.0 and sold["journal"]["totals"]["trades"] == 1  # 12 * 0.666667
    assert _ledger(db_session, flat.id) == [(12, 8.0)]
    assert (
        threads_mod.brief(db_session, flat.thread_id, row.id)["balance"] == 50_008.0
    )  # booked at once, not at day end

    rest = _mark(db_session, user_id, svc, flat.id, "long_exit")
    assert rest["open_trade"] is None and rest["journal"]["totals"]["pnl_usd"] == 20.0  # 8.00 + 12.00 = the whole
    assert _ledger(db_session, flat.id) == [(12, 8.0), (18, 12.0)]
    assert threads_mod.brief(db_session, flat.thread_id, row.id)["balance"] == 50_020.0


def test_a_sale_past_the_position_flips_it_and_the_flip_is_one_mark(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "09:40", None, open=51.0, high=51.0, low=51.0, close=51.0)
    _, flat = _flat(db_session, user_id, svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)  # at 50
    _advance(db_session, user_id, svc, flat.id, "09:45")
    flipped = _mark(db_session, user_id, svc, flat.id, "short_entry", shares=25)  # at 51: closes 10, shorts 15
    assert flipped["open_trade"]["side"] == "short" and flipped["open_trade"]["shares"] == 15
    assert flipped["open_trade"]["entry_price"] == 51.0 and flipped["open_trade"]["trade_no"] == 2
    assert flipped["journal"]["totals"]["pnl_usd"] == 10.0  # the long's 10 * (51 - 50)
    assert flipped["mark"]["trade_no"] == 2 and flipped["mark"]["shares"] == 25
    assert len(session_mod._load_marks(db_session, flat.id)) == 2  # one mark per request: the fill is one fact
    covered = _mark(db_session, user_id, svc, flat.id, "long_entry", shares=15)  # buys the short back at 51
    assert covered["open_trade"] is None and covered["journal"]["totals"]["trades"] == 2
    assert _ledger(db_session, flat.id) == [(10, 10.0), (15, 0.0)]


def test_buying_power_is_the_only_size_rule_for_a_name_already_held(db_session, user_id, svc) -> None:
    _, flat = _flat(db_session, user_id, svc, balance=1_000)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)  # 500 of 1,000
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)  # the position grows to exactly 1,000
    with pytest.raises(ReplayProblem) as broke:  # what she holds is cash spent: one more share has none left
        _mark(db_session, user_id, svc, flat.id, "long_entry", shares=1)
    assert (broke.value.message, broke.value.path, broke.value.status) == (
        "Not enough practice cash · $0 free", "shares", 422
    )  # fmt: skip
    assert len(session_mod._load_marks(db_session, flat.id)) == 2  # nothing was written
    _mark(db_session, user_id, svc, flat.id, "short_entry", shares=5)  # selling needs no cash, however little is free

    with pytest.raises(ReplayProblem) as past:  # 15 held: 40 sold closes 15 and shorts 25 = 1,250 > the 1,000 it frees
        _mark(db_session, user_id, svc, flat.id, "short_entry", shares=40)
    assert past.value.message == "Not enough practice cash · $1,000 free"
    assert len(session_mod._load_marks(db_session, flat.id)) == 3
    _mark(db_session, user_id, svc, flat.id, "short_entry", shares=35)  # 15 closed, 20 short = exactly the 1,000 freed
    assert _mark(db_session, user_id, svc, flat.id, "short_exit")["open_trade"] is None


def test_other_names_open_positions_count_against_the_cash_of_a_fill(db_session, user_id, svc) -> None:
    make_thread(db_session, user_id, starting_balance=1_000)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    _mark(db_session, user_id, svc, gapper.id, "long_entry", shares=5)  # 550 of 1,000 at 110
    flat, _ = _enter(db_session, user_id, svc, row, "FLAT", shares=5)  # 250: 200 left
    with pytest.raises(ReplayProblem) as rest:
        _mark(db_session, user_id, svc, flat.id, "long_entry", shares=5)  # 250 more than the 200 left
    assert rest.value.message == "Not enough practice cash · $200 free"
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=4)


def test_each_fill_of_a_scale_in_is_stamped_with_the_day_pnl_the_max_loss_rule_reads(
    db_session, user_id, svc, world
) -> None:
    _bend(world, "FLAT", "09:40", None, open=48.0, high=48.0, low=48.0, close=48.0)
    _, flat = _flat(db_session, user_id, svc)
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=100)  # at 50
    _advance(db_session, user_id, svc, flat.id, "09:45")  # 2 under its entry on 100 shares
    _mark(db_session, user_id, svc, flat.id, "long_entry", shares=10)
    snapshots = [
        float(m.day_pnl_usd)
        for m in db_session.query(PracticeMark)
        .filter_by(session_id=flat.id, kind="long_entry")
        .order_by(PracticeMark.seq)
    ]
    assert snapshots == [0.0, -200.0]
