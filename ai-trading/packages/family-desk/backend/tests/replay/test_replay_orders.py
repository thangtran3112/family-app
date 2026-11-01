"""Working-order fills (`replay/orders.py`): hand-built one-minute bars, every expected price checkable by hand. Pure:
no database. A fill is always on a bar that closes inside `(since, target]`, at a price that bar proves."""

import pandas as pd
import pytest

from ai_trading.replay.orders import OrderProblem, check_new, first_fill, marketable

T0 = pd.Timestamp("2026-10-27T14:00:00Z")  # the order is placed at 14:00; the first eligible bar opens at 14:00
MIN = pd.Timedelta(minutes=1)


def bars(*rows: tuple[float, float, float, float]) -> pd.DataFrame:
    """One bar per tuple (open, high, low, close), the first opening at T0."""
    index = pd.DatetimeIndex([T0 + i * MIN for i in range(len(rows))])
    return pd.DataFrame(rows, index=index, columns=["open", "high", "low", "close"])


def fill(side, type_, *, limit=None, trigger=None, triggered_at=None, frame, since=T0, target=None):
    target = target if target is not None else frame.index[-1] + MIN
    return first_fill(
        side=side, type_=type_, limit=limit, trigger=trigger, triggered_at=triggered_at, bars_1m=frame,
        since=since, target=target,
    )  # fmt: skip


# -- limit ------------------------------------------------------------------------------------------------------


def test_a_buy_limit_fills_at_its_limit_on_the_first_bar_that_reaches_it():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.0, 9.7, 9.8), (9.8, 9.9, 9.5, 9.6))
    got, triggered = fill("long", "limit", limit=9.75, frame=frame)
    assert (got.price, got.at, triggered) == (9.75, T0 + 2 * MIN, None)  # bar 2 (low 9.7) closes at 14:02


def test_a_buy_limit_fills_at_the_open_when_the_bar_opened_through_it():
    frame = bars((10.0, 10.1, 9.9, 10.0), (9.4, 9.6, 9.3, 9.5))  # gaps down through a 9.75 limit
    got, _ = fill("long", "limit", limit=9.75, frame=frame)
    assert got.price == 9.4  # better than the limit, as at a broker


def test_a_sell_limit_mirrors_it_with_the_high():
    frame = bars((10.0, 10.2, 9.9, 10.1), (10.1, 10.6, 10.0, 10.5))
    got, _ = fill("short", "limit", limit=10.5, frame=frame)
    assert (got.price, got.at) == (10.5, T0 + 2 * MIN)
    gap, _ = fill("short", "limit", limit=10.5, frame=bars((10.0, 10.2, 9.9, 10.1), (10.8, 10.9, 10.7, 10.8)))
    assert gap.price == 10.8


def test_a_limit_the_tape_never_reaches_does_not_fill():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.1, 9.9, 10.0))
    assert fill("long", "limit", limit=9.5, frame=frame) == (None, None)


# -- stop -------------------------------------------------------------------------------------------------------


def test_a_buy_stop_fills_at_the_trigger_and_a_sell_stop_mirrors_it():
    up = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.4, 10.0, 10.3))
    assert fill("long", "stop", trigger=10.25, frame=up)[0].price == 10.25
    down = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.0, 9.6, 9.7))
    assert fill("short", "stop", trigger=9.75, frame=down)[0].price == 9.75


def test_a_stop_that_gaps_past_its_trigger_fills_at_the_open_not_the_trigger():
    gap_up = bars((10.0, 10.1, 9.9, 10.0), (10.6, 10.8, 10.5, 10.7))
    assert fill("long", "stop", trigger=10.25, frame=gap_up)[0].price == 10.6
    gap_down = bars((10.0, 10.1, 9.9, 10.0), (9.4, 9.5, 9.3, 9.4))
    assert fill("short", "stop", trigger=9.75, frame=gap_down)[0].price == 9.4


# -- stop-limit -------------------------------------------------------------------------------------------------


def test_a_stop_limit_whose_limit_accepts_the_trigger_fills_on_the_trigger_bar():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.4, 10.0, 10.3))
    got, triggered = fill("long", "stop_limit", trigger=10.25, limit=10.3, frame=frame)
    assert (got.price, got.at, triggered) == (10.25, T0 + 2 * MIN, T0 + 2 * MIN)


def test_a_stop_limit_that_cannot_fill_at_the_trigger_waits_for_the_limit_on_a_later_bar():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.4, 10.0, 10.3), (10.3, 10.4, 10.1, 10.2), (10.2, 10.2, 10.0, 10.1))
    got, triggered = fill("long", "stop_limit", trigger=10.25, limit=10.1, frame=frame)
    assert triggered == T0 + 2 * MIN  # fired on bar 1 (closes 14:02)
    assert (got.price, got.at) == (10.1, T0 + 3 * MIN)  # bar 2 (low 10.1) is the first LATER bar to reach 10.1


def test_a_triggered_stop_limit_reads_only_the_limit_leg_from_then_on():
    first = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.4, 10.0, 10.3))
    got, triggered = fill("long", "stop_limit", trigger=10.25, limit=10.1, frame=first)
    assert got is None and triggered == T0 + 2 * MIN
    more = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.4, 10.0, 10.3), (10.3, 10.3, 10.05, 10.1))
    got, triggered = fill(
        "long", "stop_limit", trigger=10.25, limit=10.1, triggered_at=triggered, frame=more, since=T0 + 2 * MIN
    )
    assert (got.price, got.at) == (10.1, T0 + 3 * MIN)


def test_a_sell_stop_limit_mirrors_the_buy():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.0, 9.6, 9.7))
    got, _ = fill("short", "stop_limit", trigger=9.75, limit=9.7, frame=frame)
    assert got.price == 9.75


# -- no lookahead -----------------------------------------------------------------------------------------------


def test_bars_that_close_after_the_target_are_never_read():
    frame = bars((10.0, 10.1, 9.9, 10.0), (10.0, 10.0, 9.0, 9.1))  # bar 1 would fill a 9.5 buy limit
    assert fill("long", "limit", limit=9.5, frame=frame, target=T0 + MIN) == (None, None)  # target closes bar 0 only
    got, _ = fill("long", "limit", limit=9.5, frame=frame, target=T0 + 2 * MIN)
    assert got.price == 9.5


def test_bars_that_closed_before_the_order_was_placed_are_never_read():
    frame = bars((10.0, 10.0, 9.0, 9.1), (10.0, 10.1, 9.9, 10.0))  # bar 0 reached 9.5, but it closed at 14:01
    assert fill("long", "limit", limit=9.5, frame=frame, since=T0 + MIN)[0] is None


# -- validation -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("side", "type_", "limit", "trigger", "message"),
    [
        ("long", "limit", None, None, "Enter a limit price"),
        ("long", "limit", 0, None, "Limit price must be a number above 0"),
        ("long", "limit", float("nan"), None, "Limit price must be a number above 0"),
        ("long", "limit", 9.0, 9.5, "This order type takes no stop price"),
        ("long", "stop", None, None, "Enter a stop price"),
        ("long", "stop", 9.0, 9.5, "This order type takes no limit price"),
        ("long", "stop", None, 10.0, "A buy stop goes above the last price"),
        ("short", "stop", None, 10.0, "A sell stop goes below the last price"),
        ("short", "stop_limit", 10.0, 10.5, "A sell stop goes below the last price"),
        ("long", "market", None, None, "Choose limit, stop or stop-limit"),
    ],
)
def test_check_new_names_what_is_wrong_in_a_plain_sentence(side, type_, limit, trigger, message):
    with pytest.raises(OrderProblem) as err:
        check_new(side=side, type_=type_, limit=limit, trigger=trigger, last=10.0)
    assert err.value.message == message


def test_check_new_returns_the_levels_and_marketable_limits_are_the_ones_through_the_market():
    assert check_new(side="long", type_="stop_limit", limit=10.6, trigger=10.5, last=10.0) == (10.6, 10.5)
    assert check_new(side="short", type_="stop", limit=None, trigger=9.5, last=10.0) == (None, 9.5)
    assert marketable("long", "limit", 10.0, 10.0) and not marketable("long", "limit", 9.99, 10.0)
    assert marketable("short", "limit", 10.0, 10.0) and not marketable("short", "limit", 10.01, 10.0)
    assert not marketable("long", "stop", None, 10.0)
