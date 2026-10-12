"""`engine.tick.tick` (PROTO-BRIEF.md section 4 L2, section 3 Review Focus, section 7 Acceptance).

No IBKR in Phase 3 (D-c): there is no true per-minute "bar close" event to subscribe to, so
catch-up safety comes from `evaluate()` reporting every candidate closed by `as_of` on every call
plus the outbox's own unique-constraint dedupe -- not from any tick-side bookkeeping. These tests
exercise exactly that: a restart (the same `now` ticked twice) and a gap (several missed intervals
caught up in one call)."""

from datetime import date

import pandas as pd
from bars import minute_bars, set_bar
from sqlalchemy import select
from sqlalchemy.orm import Session
from strategies import make_spec, make_strategy, make_user, make_watchlist

from ai_trading.core.calendar import et
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.tick import tick

DAY = date(2026, 10, 6)  # a Tuesday, same fixture day test_evaluate.py uses
CLOSE_ABOVE_100 = {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100.0}}


def _store_minute_bars(db_session: Session, symbol: str, asset: str, bars: pd.DataFrame, *, now: pd.Timestamp) -> None:
    upsert_bars(db_session, symbol, "1m", bars, "test-fixture", asset, now=now)


def _watchlist_strategy(
    db_session: Session,
    *,
    symbol: str = "AAPL",
    asset_type: str = "stock",
    when: dict = CLOSE_ABOVE_100,
    run_on: str = "bar_close_1m",
    stage: str = "alert_only",
    channels: list[str] | None = None,
) -> tuple[int, int]:
    user_id = make_user(db_session)
    make_watchlist(db_session, user_id, "core", [(symbol, asset_type)])
    _, version_id = make_strategy(
        db_session,
        user_id,
        make_spec(when=when, run_on=run_on, universe={"watchlist": "core"}, channels=channels),
        stage=stage,
    )
    db_session.commit()
    return user_id, version_id


# --- Acceptance: an alert_only template alerts from live data -----------------------------------


def test_an_alert_only_template_creates_a_signal_and_a_pending_inbox_delivery(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)  # crosses above 100 on this bar
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 1
    assert result.errors == []
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.symbol == "AAPL"
    assert signal.data_quality == "delayed-15m"
    delivery = db_session.execute(select(Delivery)).scalar_one()
    assert delivery.channel == "inbox"
    assert delivery.status == "pending"


# --- Review Focus 1: a restart sends no duplicate alert ------------------------------------------


def test_restart_replaying_an_already_signaled_bar_creates_no_second_alert(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    first = tick(db_session, now=et(DAY, "20:00"))
    # A restart re-runs the same tick (the process has no memory of what it already evaluated).
    second = tick(db_session, now=et(DAY, "20:00"))

    assert first.new_signals == 1
    assert second.new_signals == 0
    assert len(db_session.execute(select(Signal)).scalars().all()) == 1
    assert len(db_session.execute(select(Alert)).scalars().all()) == 1


# --- Review Focus 2: a missed tick catches up exactly once ----------------------------------------


def test_a_gap_in_ticks_evaluates_every_closed_bar_once_on_the_next_tick(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    # Two separate rising edges, as if several 60s ticks were missed while both happened.
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:05", close=99.0)
    set_bar(bars, DAY, "10:10", close=101.5)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    caught_up = tick(db_session, now=et(DAY, "20:00"))
    replayed = tick(db_session, now=et(DAY, "20:00"))

    assert caught_up.new_signals == 2  # both edges, caught up in the single next tick
    assert replayed.new_signals == 0  # each is a no-op on a later replay, never duplicated
    assert len(db_session.execute(select(Signal)).scalars().all()) == 2


# --- Review Focus 3: the degraded alert ------------------------------------------------------------


def test_a_bar_close_1m_stock_strategy_alerts_degraded_with_delayed_15m_quality(db_session: Session):
    _watchlist_strategy(db_session, symbol="AAPL", asset_type="stock")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 1
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.data_quality == "delayed-15m"  # degraded: no live streaming slot in Phase 3 (D-c)


def test_a_bar_close_1m_future_strategy_never_fires_quality_unavailable(db_session: Session):
    _watchlist_strategy(db_session, symbol="ES", asset_type="future")
    # Deliberately no bars stored at all for ES: an "unavailable" future is skipped before any
    # bar is even read, so a missing bars table for it must never surface as an error either.
    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0  # skipped before evaluate() was ever attempted
    assert result.errors == []
    assert db_session.execute(select(Signal)).first() is None


# --- robustness: one bad strategy never aborts the others ------------------------------------------


def test_one_strategys_evaluation_error_does_not_abort_the_rest_of_the_tick(db_session: Session):
    # A daily_close strategy using an intraday-only operand fails ai_trading.core.evaluate.check()
    # on every tick -- evaluate() raises ValueError for it, every time, regardless of its bars.
    bad_user = make_user(db_session, "bad@example.test")
    make_watchlist(db_session, bad_user, "core", [("MSFT", "stock")])
    make_strategy(
        db_session,
        bad_user,
        make_spec(
            when={"op": "gt", "left": {"series": "vwap"}, "right": {"value": 1.0}},
            run_on="daily_close",
            universe={"watchlist": "core"},
        ),
        name="bad-strategy",
    )
    # A perfectly good strategy for a different symbol in the same tick.
    _watchlist_strategy(db_session, symbol="AAPL", asset_type="stock")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(
        db_session,
        now=et(DAY, "20:00"),
        live_cadences=frozenset({"bar_close_1m", "daily_close"}),
    )

    assert result.new_signals == 1  # AAPL's signal still gets written
    assert len(result.errors) == 1
    assert "bad-strategy" in result.errors[0]


# --- universe resolution: inline futures symbols use the "/" prefix convention ---------------------


def test_an_inline_future_symbol_with_a_leading_slash_is_never_evaluated(db_session: Session):
    user_id = make_user(db_session)
    make_strategy(
        db_session,
        user_id,
        make_spec(when=CLOSE_ABOVE_100, run_on="bar_close_1m", universe={"symbols": ["/ES"]}),
    )
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0


# --- stage filter: only alert_only/paper strategies are ever ticked --------------------------------


def test_a_draft_strategy_is_never_evaluated(db_session: Session):
    _watchlist_strategy(db_session, stage="draft")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0


def test_a_cadence_not_in_live_cadences_is_skipped(db_session: Session):
    _watchlist_strategy(db_session, run_on="bar_close_5m")
    result = tick(db_session, now=et(DAY, "20:00"), live_cadences=frozenset({"bar_close_1m"}))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0
