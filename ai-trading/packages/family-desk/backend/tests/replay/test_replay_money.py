"""Practice money is exact to the cent (D-033): a fill is a print rounded to the cent, P/L is `(exit - entry) * shares`
in `Decimal`, and every screen that shows a figure reads the same number.

The walkthrough bug: a META long entered at 610.83 and exited at a print of 626.475 (a sub-cent midpoint print) showed
the exit as 626.48 but booked +$1,564.50, where (626.48 - 610.83) x 100 is $1,565.00. The first group is pure; the
second runs the same trade through the services, the ledger and the thread's stats (real Postgres,
`scripts/test-db.sh`)."""

from decimal import Decimal

import pandas as pd
import pytest
from daily_world import DAYS, GAP_DAYS
from sqlalchemy import select
from test_replay_plan import _advance, _first_list
from test_replay_threads import _ledger, _mark, _stats

from ai_trading.core.calendar import et
from ai_trading.db.models import ReplaySession
from ai_trading.replay import journal as journal_mod
from ai_trading.replay import plan as plan_mod
from ai_trading.replay import session as session_mod
from ai_trading.replay import threads as threads_mod
from ai_trading.replay.journal import Trade, fill_price, pnl_usd, trade_pnl, usd_mean, usd_sum
from ai_trading.replay.model import Mark

T0 = pd.Timestamp("2026-10-23T13:30:00Z")


def _trade(side: str, entry: float, exit_: float, shares: int) -> Trade:
    return Trade(
        no=1,
        side=side,
        entry_at=T0,
        entry_price=entry,
        shares=shares,
        stop_price=None,
        exit_at=T0 + pd.Timedelta(minutes=5),
        exit_price=exit_,
    )


# -- pure: the fill, the arithmetic ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("print_price", "filled"),
    [
        (626.475, 626.48),  # the recorded META print: a half cent rounds up
        (626.474, 626.47),
        (626.4751, 626.48),
        (610.83, 610.83),  # a whole-cent print is untouched
        (100.0, 100.0),
        (0.005, 0.01),
        (1234.565, 1234.57),  # half-up, not the float's binary half-even
        (2.675, 2.68),  # the textbook case where round(2.675, 2) gives 2.67
    ],
)
def test_a_fill_is_the_print_rounded_half_up_to_the_cent(print_price: float, filled: float) -> None:
    assert fill_price(print_price) == filled


def test_a_numpy_print_fills_like_a_python_float() -> None:
    import numpy as np

    assert fill_price(np.float64(626.475)) == 626.48


def test_the_recorded_meta_trade_is_1565_dollars() -> None:
    """The reconciliation the walkthrough asked for: 100 x (626.48 - 610.83) = $1,565.00 on every path."""
    trade = _trade("long", 610.83, 626.48, 100)
    assert trade_pnl(trade) == 1565.0
    assert trade.unrealized(626.48) == 1565.0
    assert pnl_usd(1, 610.83, 626.48, 100) == 1565.0
    marks = [
        Mark(1, "long_entry", T0, 610.83, 100, None, trade_no=1),
        Mark(2, "long_exit", T0 + pd.Timedelta(minutes=5), 626.48, trade_no=1),
    ]
    j = journal_mod.compute_journal(
        marks,
        bars=pd.DataFrame(
            {"open": 610.83, "high": 626.48, "low": 610.83, "close": 626.48, "volume": 1.0},
            index=pd.date_range(T0, periods=10, freq="1min"),
        ),
        fires=[],
        plan=journal_mod.Plan(),
        display_minutes=5,
        window_start=T0,
        window_end=T0 + pd.Timedelta(minutes=10),
        as_of=T0 + pd.Timedelta(minutes=10),
        last_price=626.48,
        final=True,
    )
    assert j["totals"]["pnl_usd"] == 1565.0
    assert j["totals"]["avg_win_usd"] == 1565.0 and j["totals"]["largest_loss_usd"] is None
    assert j["trades"][0]["pnl_usd"] == 1565.0
    assert j["pnl_series"][-1]["pnl_usd"] == 1565.0


def test_the_d033_gap_was_a_sub_cent_print_not_the_arithmetic() -> None:
    """The stored 1,564.50 is what a raw 626.475 print gives; a fill at the cent gives the 1,565.00 the screen shows."""
    assert pnl_usd(1, 610.83, 626.475, 100) == 1564.5  # a legacy mark that kept the raw print still reads as booked
    assert pnl_usd(1, 610.83, fill_price(626.475), 100) == 1565.0


@pytest.mark.parametrize("side", ["long", "short"])
def test_pnl_equals_the_exact_decimal_difference_times_shares_for_any_cent_prices(side: str) -> None:
    """A grid of cent prices and share counts, each checked against plain Decimal arithmetic (no float anywhere)."""
    sign = 1 if side == "long" else -1
    prices = [0.01, 0.07, 1.1, 9.99, 19.95, 99.99, 100.01, 610.83, 626.48, 1234.56, 99999.99]
    for entry in prices:
        for exit_ in prices:
            for shares in (1, 3, 7, 100, 333, 1000):
                want = sign * (Decimal(str(exit_)) - Decimal(str(entry))) * shares
                got = trade_pnl(_trade(side, entry, exit_, shares))
                assert Decimal(str(got)) == want, (side, entry, exit_, shares, got, want)


def test_dollar_sums_and_means_do_not_drift() -> None:
    assert usd_sum([0.1, 0.2]) == 0.3  # float 0.1 + 0.2 is 0.30000000000000004
    assert usd_sum([1565.0, -0.01, 0.01]) == 1565.0
    assert usd_sum([]) == 0.0
    assert usd_mean([10.01, 10.02]) == 10.02  # 10.015 rounds half up
    assert usd_mean([]) is None


# -- through the services: print, mark, ledger, day, thread ---------------------------------------------------------


def _midpoint_world(world, price: float) -> None:
    """GAPPER trades at `price` (sub-cent) in the regular hours of the gap days instead of 110.0."""
    frame = world.minutes["GAPPER"]
    for day in GAP_DAYS:
        regular = (frame.index >= et(day, "09:30")) & (frame.index < et(day, "11:30"))
        for column in ("open", "high", "low", "close"):
            frame.loc[regular, column] = price


def test_a_sub_cent_print_is_filled_at_the_cent_and_every_figure_reads_the_same_number(
    db_session, user_id, svc, world
) -> None:
    """GAPPER enters at 106 and the exit print is 110.005: the fill is 110.01, the trade is (110.01 - 106) x 10 =
    $40.10, and the mark, the ledger row, the journal, the day and the thread all say the same $40.10."""
    _midpoint_world(world, 110.005)
    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    thread = threads_mod.active_thread(db_session, user_id)

    _advance(db_session, user_id, svc, session.id, "09:30")
    entry = _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    assert entry["mark"]["price"] == 106.0
    _advance(db_session, user_id, svc, session.id, "10:00")
    live = session_mod.session_out(
        session_mod.context(db_session, svc, session_mod.get_row(db_session, user_id, session.id))
    )
    assert live["open_trade"]["last_price"] == 110.01  # the header's LAST is the fill, not the raw print
    assert live["open_trade"]["unrealized_usd"] == 40.10  # and the unrealized figure runs on it
    exit_ = _mark(db_session, user_id, svc, session.id, "long_exit")
    assert exit_["mark"]["price"] == 110.01
    assert exit_["journal"]["totals"]["pnl_usd"] == 40.10 and exit_["journal"]["trades"][0]["pnl_usd"] == 40.10

    (booked,) = _ledger(db_session)
    assert (float(booked.entry_price), float(booked.exit_price), float(booked.pnl_usd)) == (106.0, 110.01, 40.10)
    # the reconciliation: what the mark prices say, times the shares, is exactly what the ledger booked
    assert (booked.exit_price - booked.entry_price) * booked.shares == booked.pnl_usd == Decimal("40.10")

    plan_mod.end_day(db_session, user_id, row.id, svc)
    db_session.refresh(session)
    assert session.journal["totals"]["pnl_usd"] == 40.10
    assert session.journal["pnl_series"][-1]["pnl_usd"] == 40.10
    detail = threads_mod.detail(db_session, thread)
    assert detail["daily"][0]["pnl_usd"] == 40.10 and detail["daily"][0]["balance"] == 50_040.10
    stats = _stats(db_session, thread)
    assert stats.balance == 50_040.10 and stats.bestDayUsd == stats.worstDayUsd == 40.10
    assert stats.avgWinUsd == 40.10
    assert threads_mod.brief(db_session, thread.id)["balance"] == 50_040.10
    assert plan_mod._day_journal([session])["pnl_usd"] == 40.10
    assert row.journal["pnl_usd"] == 40.10
    (hub_row,) = [r for r in session_mod.list_sessions(db_session, user_id, status=None, limit=5)]
    assert hub_row["pnl_usd"] == 40.10


def test_the_days_auto_exit_fills_at_the_cent_too(db_session, user_id, svc, world) -> None:
    _midpoint_world(world, 110.005)
    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    _advance(db_session, user_id, svc, session.id, "09:30")
    _mark(db_session, user_id, svc, session.id, "long_entry", shares=10)
    _advance(db_session, user_id, svc, session.id, "10:00")
    plan_mod.end_day(db_session, user_id, row.id, svc)
    (booked,) = _ledger(db_session)
    assert float(booked.exit_price) == 110.01 and float(booked.pnl_usd) == 40.10
    assert (
        db_session.execute(select(ReplaySession.journal).where(ReplaySession.id == session.id)).scalar_one()["totals"][
            "pnl_usd"
        ]
        == 40.10
    )


def test_thread_figures_stay_cent_exact_across_many_awkward_trades(db_session, user_id, svc) -> None:
    """Ledger rows whose cents would drift in float (0.1 + 0.2 style) still sum, average and rank to the cent."""
    from ai_trading.db.models import PracticeLedger

    row = _first_list(db_session, user_id, svc)
    session = plan_mod.start_session(db_session, user_id, row.id, "GAPPER", svc)
    thread = threads_mod.active_thread(db_session, user_id)
    for i, pnl in enumerate(["0.10", "0.20", "-0.05", "0.01", "1564.50"]):
        db_session.add(
            PracticeLedger(
                thread_id=thread.id,
                session_id=session.id,
                mark_id=_fake_mark(db_session, session.id, i),
                day=DAYS[0],
                symbol="GAPPER",
                side="long",
                shares=1,
                entry_price=Decimal("1"),
                exit_price=Decimal("1"),
                pnl_usd=Decimal(pnl),
                r=None,
                realized_at=pd.Timestamp("2026-09-28T14:00:00Z").to_pydatetime(),
                created_at=pd.Timestamp("2026-10-24T16:00:00Z").to_pydatetime(),
            )
        )
    db_session.flush()
    stats = _stats(db_session, thread)
    assert stats.balance == 51_564.76  # 50,000 + 0.10 + 0.20 - 0.05 + 0.01 + 1,564.50
    assert stats.avgWinUsd == 391.20  # 1,564.81 / 4 = 391.2025
    assert stats.avgLossUsd == -0.05
    assert (stats.wins, stats.losses) == (4, 1)


def _fake_mark(db_session, session_id: int, seq: int) -> int:
    from ai_trading.db.models import PracticeMark

    mark = PracticeMark(
        session_id=session_id,
        seq=100 + seq,
        kind="long_exit",
        at=pd.Timestamp("2026-09-28T14:00:00Z").to_pydatetime(),
        price=Decimal("1"),
        shares=None,
        stop_price=None,
        note=None,
        trade_no=100 + seq,
        source="her",
        created_at=pd.Timestamp("2026-10-24T16:00:00Z").to_pydatetime(),
    )
    db_session.add(mark)
    db_session.flush()
    return mark.id
