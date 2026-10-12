from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.jobs.backfill_watchlist import backfill_on_join


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)


def test_a_stock_symbol_backfills_1d_and_1h_from_the_free_history_start(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    result = backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()

    assert result.symbol == "AAPL"
    assert set(result.by_timeframe) == {"1d", "1h"}
    timeframes_requested = {call[1] for call in fake_bars.calls}
    assert timeframes_requested == {"1d", "1h"}
    for call in fake_bars.calls:
        assert call[2].tz_convert("America/New_York").date() >= ALPACA_FREE_HISTORY_START


def test_a_future_symbol_backfills_nothing_and_returns_an_empty_result(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    result = backfill_on_join(db_session, sources, symbol="ES", asset="future", now=NOW)

    assert result.symbol == "ES"
    assert result.by_timeframe == {}
    assert fake_bars.calls == []


def test_calling_it_twice_is_idempotent(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()
    first_call_count = len(fake_bars.calls)

    result = backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()

    # Every session in range is already stored, so the second call's own `backfill()` finds
    # nothing missing -- no new provider call, and `written` is empty for both timeframes.
    assert len(fake_bars.calls) == first_call_count
    assert all(tf_result.written == [] for tf_result in result.by_timeframe.values())
