"""`engine.tick.tick` and the outbox with the 02k contract features: a `filter` universe resolved from
a screener's stored matches, `then.alert.frequency == "once"` across a sliding evaluation window, and
`then.alert.message` as the stored alert title."""

from datetime import date

import pandas as pd
from bars import minute_bars, set_bar
from sqlalchemy import select
from sqlalchemy.orm import Session
from strategies import NOW, make_spec, make_strategy, make_user

from ai_trading.core.calendar import et
from ai_trading.core.evaluate import SignalCandidate
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Alert, Signal, Strategy
from ai_trading.engine.outbox import AlertSpec, record_signal
from ai_trading.engine.tick import tick

DAY = date(2026, 10, 6)
CLOSE_ABOVE_100 = {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100.0}}
FILTER = {"filter": "Volume leaders"}


def _store(db_session: Session, symbol: str, bars: pd.DataFrame) -> None:
    upsert_bars(db_session, symbol, "1m", bars, "test-fixture", "stock", now=et(DAY, "20:00"))


def _breakout_bars(*minutes: str) -> pd.DataFrame:
    bars = minute_bars("stock", DAY)
    for hhmm in minutes:
        set_bar(bars, DAY, hhmm, close=101.0)
    return bars


def _strategy(db_session: Session, universe: dict, **alert) -> int:
    user_id = make_user(db_session)
    make_strategy(db_session, user_id, make_spec(when=CLOSE_ABOVE_100, universe=universe, alert=alert or None))
    db_session.commit()
    return user_id


def _signal_count(db_session: Session) -> int:
    return len(db_session.execute(select(Signal)).scalars().all())


# --- watch.universe.filter -----------------------------------------------------------------------


def test_a_filter_universe_evaluates_the_symbols_the_screener_matched(db_session: Session):
    user_id = _strategy(db_session, FILTER)
    _store(db_session, "AAPL", _breakout_bars("10:00"))
    _store(db_session, "MSFT", _breakout_bars("11:00"))
    db_session.commit()
    asked = []

    def matches(session: Session, strategy: Strategy, name: str) -> list[str]:
        asked.append((strategy.owner_user_id, name))
        return ["AAPL", "MSFT"]

    result = tick(db_session, now=et(DAY, "20:00"), filter_matches=matches)

    assert asked == [(user_id, "Volume leaders")]
    assert result.errors == []
    assert result.new_signals == 2
    assert {s.symbol for s in db_session.execute(select(Signal)).scalars()} == {"AAPL", "MSFT"}


def test_a_filter_universe_without_a_resolver_is_skipped_and_reported(db_session: Session):
    _strategy(db_session, FILTER)
    _store(db_session, "AAPL", _breakout_bars("10:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0
    assert result.errors == ["test-strategy: filter 'Volume leaders' has no stored matches"]


def test_a_filter_with_no_stored_result_is_reported_but_an_empty_result_is_not(db_session: Session):
    _strategy(db_session, FILTER)

    unknown = tick(db_session, now=et(DAY, "20:00"), filter_matches=lambda *_: None)
    empty = tick(db_session, now=et(DAY, "20:00"), filter_matches=lambda *_: [])

    assert len(unknown.errors) == 1
    assert empty.errors == []
    assert empty.evaluated_strategies == 0


def test_a_futures_root_in_a_filter_result_keeps_the_slash_convention(db_session: Session):
    _strategy(db_session, FILTER)

    result = tick(db_session, now=et(DAY, "20:00"), filter_matches=lambda *_: ["/ES"])

    assert result.evaluated_strategies == 0  # a future has no data source yet (quality "unavailable")
    assert result.errors == []


# --- then.alert.frequency == "once" --------------------------------------------------------------


def test_once_alerts_a_symbol_a_single_time_even_after_its_first_signal_leaves_the_window(db_session: Session):
    user_id = make_user(db_session)
    make_strategy(
        db_session,
        user_id,
        make_spec(when=CLOSE_ABOVE_100, universe={"symbols": ["AAPL"]}, alert={"frequency": "once"}),
    )
    version_id = db_session.execute(select(Strategy.current_version_id)).scalar_one()
    # An earlier signal that has since slid out of the bars window tick() reads.
    record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=SignalCandidate("AAPL", pd.Timestamp("2026-07-01T14:30:00Z"), {"close": 101.0}),
        data_quality="delayed-15m",
        alert=AlertSpec(channels=["inbox"]),
        now=NOW,
    )
    _store(db_session, "AAPL", _breakout_bars("10:00", "12:00"))  # two fresh rising edges
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert _signal_count(db_session) == 1


def test_once_records_only_the_first_edge_for_a_symbol_with_no_earlier_signal(db_session: Session):
    _strategy(db_session, {"symbols": ["AAPL"]}, frequency="once")
    _store(db_session, "AAPL", _breakout_bars("10:00", "12:00"))
    db_session.commit()

    assert tick(db_session, now=et(DAY, "20:00")).new_signals == 1
    assert tick(db_session, now=et(DAY, "20:00")).new_signals == 0
    [signal] = db_session.execute(select(Signal)).scalars()
    assert signal.bar_time == et(DAY, "10:00")


def test_once_is_per_symbol(db_session: Session):
    _strategy(db_session, {"symbols": ["AAPL", "MSFT"]}, frequency="once")
    _store(db_session, "AAPL", _breakout_bars("10:00", "12:00"))
    _store(db_session, "MSFT", _breakout_bars("10:30", "13:00"))
    db_session.commit()

    assert tick(db_session, now=et(DAY, "20:00")).new_signals == 2


# --- then.alert.message ---------------------------------------------------------------------------


def test_a_message_becomes_the_alert_title_and_the_evidence_stays_in_the_body(db_session: Session):
    _strategy(db_session, {"symbols": ["AAPL"]}, message="{symbol} broke 100, close {close} at {time}")
    _store(db_session, "AAPL", _breakout_bars("10:00"))
    db_session.commit()

    tick(db_session, now=et(DAY, "20:00"))

    alert = db_session.execute(select(Alert)).scalar_one()
    assert alert.title == "AAPL broke 100, close 101.00 at 10:01 AM"
    assert "close=101.0" in alert.body


def test_without_a_message_the_alert_keeps_its_default_title(db_session: Session):
    _strategy(db_session, {"symbols": ["AAPL"]})
    _store(db_session, "AAPL", _breakout_bars("10:00"))
    db_session.commit()

    tick(db_session, now=et(DAY, "20:00"))

    alert = db_session.execute(select(Alert)).scalar_one()
    assert alert.title.startswith("AAPL signal at ")
