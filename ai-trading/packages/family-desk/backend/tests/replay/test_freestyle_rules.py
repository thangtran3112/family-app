"""The pure rules of the freestyle thread (ADR-0025): a split restates a position with no P/L, the day rules count per
ET date, a Day order lives to its session's extended close, a closing order is reduce-only, and an order is read across
as many data days as a move crosses. No database, no network."""

from datetime import date

import pandas as pd
import pytest

from ai_trading.core.calendar import et
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import orders as orders_mod
from ai_trading.replay.model import Mark, Plan

MON, TUE, WED, FRI, SAT = date(2026, 9, 28), date(2026, 9, 29), date(2026, 9, 30), date(2026, 10, 2), date(2026, 10, 3)


def _mark(seq: int, kind: str, at: pd.Timestamp, price: float | None, shares: int | None = None, **kw) -> Mark:
    return Mark(seq=seq, kind=kind, at=at, price=price, shares=shares, **kw)  # type: ignore[arg-type]


# -- a split restates the position, never the P/L ---------------------------------------------------------------------


def test_a_split_scales_shares_and_cost_and_the_trade_that_closes_it_earns_the_same() -> None:
    marks = [
        _mark(1, "long_entry", et(MON, "10:00"), 100.0, 100, stop_price=90.0),
        _mark(2, "split", et(WED, "04:00"), None, ratio=2.0),
        _mark(3, "long_exit", et(WED, "12:00"), 55.0),
    ]
    closed, open_ = journal_mod.assemble(marks[:2])
    assert open_ is not None and (open_.shares, open_.entry_price, open_.stop_price) == (200, 50.0, 45.0)
    assert open_.stops == [(et(MON, "10:00"), 45.0)] and closed == []
    # The same 10 dollars a share it would have made on the old basis: (55 * 2 - 100) per old share, 100 old shares
    closed, open_ = journal_mod.assemble(marks)
    assert open_ is None and journal_mod.trade_pnl(closed[0]) == 1000.0 and closed[0].shares == 200


def test_a_reverse_split_that_rounds_the_position_away_closes_it_without_a_trade() -> None:
    marks = [_mark(1, "long_entry", et(MON, "10:00"), 20.0, 3), _mark(2, "split", et(TUE, "04:00"), None, ratio=0.25)]
    closed, open_ = journal_mod.assemble(marks)
    assert open_ is None and closed == []  # cash in lieu is not modeled (ADR-0025 D9)


# -- the day rules count per ET date ---------------------------------------------------------------------------------


def _trade(entry: pd.Timestamp, exit_: pd.Timestamp) -> journal_mod.Trade:
    return journal_mod.Trade(1, "long", entry, 10.0, 1, None, exit_at=exit_, exit_price=11.0, entries=[(entry, None)])


def test_the_trade_limit_and_the_max_loss_count_one_et_date_at_a_time() -> None:
    first, second = _trade(et(MON, "10:00"), et(MON, "11:00")), _trade(et(TUE, "10:00"), et(TUE, "11:00"))
    plan = Plan(max_trades=1)
    bars = pd.DataFrame(columns=["open", "high", "low", "close", "volume"], index=pd.DatetimeIndex([], tz="UTC"))

    def limit(day: date | None) -> dict:
        checks = journal_mod._checks([first], plan, [], bars, 5, [second], day)
        return next(c for c in checks if c["id"] == "max_trades")

    assert limit(None)["passed"] is False  # two trades over two dates, no date: the old count
    assert limit(MON)["passed"] is True and limit(MON)["detail"] == "1 of 1"  # Monday's one trade
    assert limit(TUE)["passed"] is True


# -- orders across days ------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("placed", "expires"),
    [
        (et(MON, "10:00"), et(MON, "20:00")),  # during the session
        (et(MON, "03:00"), et(MON, "20:00")),  # before its extended open: that session
        (et(MON, "21:00"), et(TUE, "20:00")),  # after the extended close: the next session
        (et(FRI, "20:00"), et(date(2026, 10, 5), "20:00")),  # exactly at the close: Monday's
        (et(SAT, "12:00"), et(date(2026, 10, 5), "20:00")),  # a weekend: Monday's
    ],
)
def test_a_day_order_expires_at_the_extended_close_of_its_session(placed: pd.Timestamp, expires: pd.Timestamp) -> None:
    assert orders_mod.day_expiry(placed) == expires


def test_a_reduce_only_order_fills_no_more_than_the_position_and_nothing_once_it_is_gone() -> None:
    assert orders_mod.reduce_shares(100, "short", "long", 100) == 100  # a sell against a long
    assert orders_mod.reduce_shares(100, "short", "long", 40) == 40  # the position shrank by hand
    assert orders_mod.reduce_shares(100, "short", None, 0) == 0  # already closed
    assert orders_mod.reduce_shares(100, "short", "short", 50) == 0  # it would no longer reduce anything


def _flat_days(days: list[date], price: float = 50.0) -> pd.DataFrame:
    frames = []
    for day in days:
        index = pd.date_range(et(day, "04:00"), et(day, "19:59"), freq="1min")
        frames.append(pd.DataFrame({c: price for c in ("open", "high", "low", "close")} | {"volume": 1.0}, index=index))
    return pd.concat(frames)


def test_an_order_is_read_across_every_day_of_a_move_and_a_gap_fills_at_the_open() -> None:
    bars = _flat_days([MON, TUE, WED])
    gap = bars.index >= et(TUE, "04:00")
    bars.loc[gap, ["open", "high", "low", "close"]] = 40.0  # Tuesday gaps down through a sell stop at 48
    fill, _ = orders_mod.first_fill_across(
        side="short",
        type_="stop",
        limit=None,
        trigger=48.0,
        triggered_at=None,
        minutes_of=lambda day: bars,
        since=et(MON, "10:00"),
        target=et(WED, "12:00"),
    )
    assert fill is not None and (fill.at, fill.price) == (et(TUE, "04:01"), 40.0)
    nothing, _ = orders_mod.first_fill_across(
        side="short",
        type_="stop",
        limit=None,
        trigger=48.0,
        triggered_at=None,
        minutes_of=lambda day: bars,
        since=et(MON, "10:00"),
        target=et(MON, "20:00"),  # a move that stops before the gap sees none of it
    )
    assert nothing is None


def test_a_move_longer_than_one_chunk_reads_each_chunk_once_and_carries_a_stop_limit_trigger() -> None:
    reads: list[date] = []
    sessions = orders_mod.chunk_ends(et(date(2026, 9, 14), "10:00"), et(date(2026, 10, 2), "12:00"))
    assert len(sessions) == 2 and sessions[-1] == FRI  # 14 sessions: a chunk of ten, then the rest

    bars = _flat_days([MON])
    bars.loc[bars.index >= et(MON, "10:00"), ["open", "high", "low", "close"]] = 52.0  # stop 51 triggers on Monday

    def minutes_of(day: date) -> pd.DataFrame:
        reads.append(day)
        return bars

    fill, fired = orders_mod.first_fill_across(
        side="long",
        type_="stop_limit",
        limit=50.0,  # the limit rejects the trigger price, so only a later bar at or below 50 fills it
        trigger=51.0,
        triggered_at=None,
        minutes_of=minutes_of,
        since=et(date(2026, 9, 25), "10:00"),
        target=et(FRI, "12:00"),
    )
    assert fill is None and fired == et(MON, "10:01")  # triggered in the first chunk, still waiting after the second
    assert len(reads) == 1  # one chunk of sessions, one read
