"""Working orders in a day replay (`session.place_order`, `cancel_order`, the fill pass inside `advance`): a limit, stop
or stop-limit entry waits on the tape and fills only on a later one-minute bar, never earlier than its placement,
never past the playhead. Real Postgres; the synthetic world of `tests/daily_world.py` (FLAT sits at 50 all day; GAPPER
at 110). Tests bend a bar of FLAT to make a level trade."""

import pytest
from daily_world import DAYS, make_thread
from test_day_positions import _bend
from test_replay_plan import _advance
from test_replay_switch import _names

from ai_trading.core.calendar import et
from ai_trading.db.models import ReplaySession
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay.session import ReplayProblem, SessionNotFound


def _order(db_session, user_id, svc, session_id, **body):
    out = session_mod.place_order(db_session, user_id, session_id, svc, body)
    db_session.commit()
    return out


def _flat(db_session, user_id, svc, *, balance=50_000, **plan):
    """FLAT's session at 09:35 on a list that also has GAPPER; FLAT dips to 49.0 in its 10:20 bar and spikes to 51.5."""
    make_thread(db_session, user_id, starting_balance=balance, **plan)
    row, gapper = _names(db_session, user_id, svc, "FLAT")
    _advance(db_session, user_id, svc, gapper.id, "09:35")
    flat = plan_mod.start_session(db_session, user_id, row.id, "FLAT", svc)
    return row, gapper, flat


def _orders(db_session, session_id):
    db_session.expire_all()
    return db_session.get(ReplaySession, session_id).orders


def test_a_buy_limit_waits_and_fills_on_the_bar_that_reaches_it(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, _, flat = _flat(db_session, user_id, svc)
    placed = _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    assert placed["mark"] is None and placed["open_trade"] is None
    assert placed["order"] | {"placed_at": None} == {
        "id": 1, "side": "buy", "type": "limit", "shares": 10, "limit_price": 49.5, "stop_price": None,
        "status": "working", "placed_at": None, "triggered_at": None, "closed_at": None, "fill_price": None,
        "mark_id": None, "reason": None,
    }  # fmt: skip

    early = _advance(db_session, user_id, svc, flat.id, "10:10")  # the dip has not happened yet
    assert early["fills"] is None and early["open_trade"] is None and early["orders"][0]["status"] == "working"

    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    (fill,) = out["fills"]
    assert (fill["kind"], fill["price"], fill["shares"], fill["at"]) == ("long_entry", 49.5, 10, et(DAYS[0], "10:21"))
    assert out["open_trade"]["entry_price"] == 49.5 and out["open_trade"]["shares"] == 10
    (order,) = out["orders"]
    assert (order["status"], order["fill_price"], order["mark_id"]) == ("filled", 49.5, fill["id"])
    assert order["closed_at"] == et(DAYS[0], "10:21").isoformat()


def test_a_fill_is_never_read_from_a_bar_that_closed_after_the_playhead(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    out = _advance(db_session, user_id, svc, flat.id, "10:20")  # the 10:20 bar closes at 10:21: not revealed yet
    assert out["fills"] is None and out["orders"][0]["status"] == "working"
    out = _advance(db_session, user_id, svc, flat.id, "10:21")
    assert out["fills"][0]["price"] == 49.5


def test_a_dip_before_the_order_was_placed_does_not_fill_it(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "09:36", "09:37", low=49.0)  # the order is placed at 09:40, after this dip
    _, gapper, flat = _flat(db_session, user_id, svc)
    _advance(db_session, user_id, svc, gapper.id, "09:40")
    _advance(db_session, user_id, svc, flat.id, "09:40")
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    out = _advance(db_session, user_id, svc, flat.id, "11:00")
    assert out["fills"] is None and out["orders"][0]["status"] == "working"


def test_a_buy_stop_fills_at_its_trigger(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", high=51.5)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="stop", stopPrice=51.0, shares=4)
    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    assert (out["fills"][0]["kind"], out["fills"][0]["price"]) == ("long_entry", 51.0)


def test_a_stop_limit_fills_at_the_trigger_when_its_limit_accepts_it(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", high=51.5)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(
        db_session, user_id, svc, flat.id, side="buy", orderType="stop_limit", stopPrice=51.0, limitPrice=51.2, shares=2
    )
    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    assert out["fills"][0]["price"] == 51.0 and out["orders"][0]["triggered_at"] == et(DAYS[0], "10:21").isoformat()


def test_a_stop_limit_that_cannot_fill_at_the_trigger_waits_and_remembers_it_triggered(
    db_session, user_id, svc, world
) -> None:
    _bend(world, "FLAT", "10:20", "10:21", high=51.5)
    _bend(world, "FLAT", "10:40", "10:41", low=49.4)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(
        db_session, user_id, svc, flat.id, side="buy", orderType="stop_limit", stopPrice=51.0, limitPrice=49.5, shares=2
    )
    out = _advance(db_session, user_id, svc, flat.id, "10:30")  # triggered at 51, the limit 49.5 is below it: waits
    assert out["fills"] is None
    assert (
        out["orders"][0]["status"] == "working" and out["orders"][0]["triggered_at"] == et(DAYS[0], "10:21").isoformat()
    )
    out = _advance(db_session, user_id, svc, flat.id, "10:50")  # the 10:40 bar's low reaches 49.5
    assert (out["fills"][0]["price"], out["fills"][0]["at"]) == (49.5, et(DAYS[0], "10:41"))


def test_a_limit_through_the_market_fills_at_once_at_the_last_print(db_session, user_id, svc) -> None:
    _, _, flat = _flat(db_session, user_id, svc)
    placed = _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=51.0, shares=3)
    assert (placed["mark"]["kind"], placed["mark"]["price"], placed["order"]["status"]) == (
        "long_entry",
        50.0,
        "filled",
    )
    assert placed["order"]["mark_id"] == placed["mark"]["id"] and placed["open_trade"]["shares"] == 3


@pytest.mark.parametrize(
    ("body", "path", "message"),
    [
        ({"side": "buy", "orderType": "stop", "stopPrice": 49.0}, "stopPrice", "A buy stop goes above the last price"),
        ({"side": "sell", "orderType": "stop", "stopPrice": 51.0}, "stopPrice", "A sell stop goes below the last price"),  # noqa: E501
        ({"side": "buy", "orderType": "limit"}, "limitPrice", "Enter a limit price"),
        ({"side": "buy", "orderType": "stop", "stopPrice": 51.0, "limitPrice": 52.0}, "limitPrice",
         "This order type takes no limit price"),
        ({"side": "buy", "orderType": "limit", "limitPrice": 40.0, "shares": 1000}, "shares",
         "Not enough practice cash · $1,000 free"),
    ],
)  # fmt: skip
def test_an_order_is_refused_with_a_plain_sentence_and_nothing_is_stored(
    db_session, user_id, svc, body, path, message
) -> None:
    _, _, flat = _flat(db_session, user_id, svc, balance=1_000)
    with pytest.raises(ReplayProblem) as caught:
        session_mod.place_order(db_session, user_id, flat.id, svc, body)
    assert (caught.value.path, caught.value.message) == (path, message)
    assert _orders(db_session, flat.id) == []


def test_an_order_needs_no_stop_and_an_order_on_a_held_name_is_accepted(db_session, user_id, svc, world) -> None:
    _, _, flat = _flat(db_session, user_id, svc, stopNoteOnEntry="yes")
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=51.0, shares=1)  # fills now
    waiting = _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=40.0, shares=1)
    assert waiting["order"]["status"] == "working"  # the name is held; a second order is just another buy


def test_cancel_stops_an_order_filling_and_is_a_409_the_second_time(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, _, flat = _flat(db_session, user_id, svc)
    placed = _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    cancelled = session_mod.cancel_order(db_session, user_id, flat.id, placed["order"]["id"], svc)
    db_session.commit()
    assert cancelled["order"]["status"] == "cancelled" and cancelled["order"]["fill_price"] is None
    assert _advance(db_session, user_id, svc, flat.id, "10:30")["fills"] is None
    with pytest.raises(ReplayProblem) as caught:
        session_mod.cancel_order(db_session, user_id, flat.id, placed["order"]["id"], svc)
    assert (caught.value.message, caught.value.status) == ("That order is no longer working", 409)
    with pytest.raises(SessionNotFound):
        session_mod.cancel_order(db_session, user_id, flat.id, 99, svc)


def test_a_second_order_on_a_name_fills_into_the_same_position_at_the_average_cost(
    db_session, user_id, svc, world
) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.2, shares=5)
    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    assert [f["shares"] for f in out["fills"]] == [10, 5]  # both reached by the same bar, in order id order
    first, second = out["orders"]
    assert (first["status"], second["status"]) == ("filled", "filled")
    assert (first["fill_price"], second["fill_price"]) == (49.5, 49.2)
    assert (out["open_trade"]["shares"], out["open_trade"]["entry_price"]) == (15, 49.4)  # (495 + 246) / 15


def test_a_working_sell_against_a_long_fills_as_a_partial_exit_on_the_tape(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", high=52.0)
    _, _, flat = _flat(db_session, user_id, svc)
    session_mod.place_mark(db_session, user_id, flat.id, svc, {"kind": "long_entry", "shares": 10})  # at 50
    db_session.commit()
    waiting = _order(db_session, user_id, svc, flat.id, side="sell", orderType="limit", limitPrice=51.5, shares=4)
    assert waiting["order"]["status"] == "working" and waiting["open_trade"]["shares"] == 10
    assert _advance(db_session, user_id, svc, flat.id, "10:10")["fills"] is None  # the spike has not happened yet
    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    (fill,) = out["fills"]
    assert (fill["kind"], fill["price"], fill["shares"], fill["at"]) == ("short_entry", 51.5, 4, et(DAYS[0], "10:21"))
    assert (out["open_trade"]["side"], out["open_trade"]["shares"], out["open_trade"]["entry_price"]) == (
        "long",
        6,
        50.0,
    )
    row = db_session.get(ReplaySession, flat.id)
    assert row.orders[0]["status"] == "filled" and row.orders[0]["fill_price"] == 51.5
    journal = session_mod.context(db_session, svc, row)
    assert [(t.shares, t.exit_price) for t in session_mod.journal_mod.assemble(journal.marks)[0]] == [(4, 51.5)]


def test_an_order_the_account_can_no_longer_afford_is_cancelled_with_the_reason(
    db_session, user_id, svc, world
) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, gapper, flat = _flat(db_session, user_id, svc, balance=1_000)
    _order(
        db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=15
    )  # 742.50 <= 1,000
    session_mod.place_mark(db_session, user_id, gapper.id, svc, {"kind": "long_entry", "shares": 5})  # 550 of the cash
    db_session.commit()
    out = _advance(db_session, user_id, svc, flat.id, "10:30")
    assert out["fills"] is None and out["open_trade"] is None
    assert (
        out["orders"][0]["status"] == "cancelled"
        and out["orders"][0]["reason"] == "Not enough practice cash · $450 free"
    )


def test_a_filled_order_cannot_be_undone_but_its_trade_can_be_exited(db_session, user_id, svc, world) -> None:
    _bend(world, "FLAT", "10:20", "10:21", low=49.0)
    _, _, flat = _flat(db_session, user_id, svc)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=49.5, shares=10)
    out = _advance(db_session, user_id, svc, flat.id, "10:21")
    with pytest.raises(ReplayProblem) as caught:
        session_mod.undo_mark(db_session, user_id, flat.id, out["fills"][0]["id"], svc)
    assert (caught.value.message, caught.value.status) == (
        "A filled order can't be undone · exit the trade instead",
        409,
    )
    exited = session_mod.place_mark(db_session, user_id, flat.id, svc, {"kind": "long_exit"})
    assert exited["mark"]["price"] == 50.0 and exited["open_trade"] is None


def test_what_still_waits_when_the_day_ends_is_cancelled(db_session, user_id, svc) -> None:
    _, _, flat = _flat(db_session, user_id, svc)
    _order(db_session, user_id, svc, flat.id, side="buy", orderType="limit", limitPrice=40.0, shares=1)
    session_mod.end(db_session, user_id, flat.id, svc, via_day=True)
    db_session.commit()
    (order,) = _orders(db_session, flat.id)
    assert (order["status"], order["reason"]) == ("cancelled", "The day ended")
