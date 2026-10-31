"""`bridge_shadow` (02t §7 B2): the direct chain against the bridge, logged as one JSON line per symbol.

A fake on both sides, so nothing here touches the network: the bridge double answers `pinned_quotes` with
whatever the test says, and the direct side is a one-provider stand-in for `data_sources.quotes`.
"""

import json
import logging
from datetime import UTC, datetime
from types import SimpleNamespace

import pandas as pd
import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.types import Quote

from ai_trading.jobs import bridge_shadow

NOW = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)  # 10:00 ET on a Friday


@pytest.fixture(autouse=True)
def _logger_on(monkeypatch):
    # Alembic's `fileConfig` (run by the DB fixtures) disables every logger that already exists -- the same
    # workaround `test_scheduler.py` uses. These tests assert on the job's JSON lines.
    monkeypatch.setattr(bridge_shadow.logger, "disabled", False)
AS_OF = pd.Timestamp("2026-10-30T13:45:00Z")


def quote(
    symbol: str = "AAPL", price: float = 190.0, *, provider: str = "alpaca", quality: str = "delayed-15m"
) -> Quote:
    return Quote(symbol=symbol, price=price, as_of=AS_OF, provider=provider, quality=quality)


class FakeQuotes:
    def __init__(self, quotes=None, *, raises=None) -> None:
        self.quotes = quotes if quotes is not None else [quote()]
        self.raises = raises
        self.calls: list[tuple] = []

    def latest(self, symbols, *, now):
        self.calls.append(tuple(symbols))
        if self.raises is not None:
            raise self.raises
        return self.quotes


class FakeBridge:
    def __init__(self, quotes=None, *, raises=None) -> None:
        self.quotes = quotes if quotes is not None else [quote()]
        self.raises = raises
        self.pins: list[tuple] = []

    def pinned_quotes(self, symbols, *, now, provider=None):
        self.pins.append((tuple(symbols), provider))
        if self.raises is not None:
            raise self.raises
        return self.quotes


def sources(*, direct=None, bridge=None):
    return SimpleNamespace(quotes=direct or FakeQuotes(), bridge=bridge if bridge is not None else FakeBridge())


def _lines(caplog) -> list[dict]:
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "ai_trading.jobs.bridge_shadow"
    ]


def test_due_now_is_true_only_on_five_minute_marks_in_the_regular_session():
    assert bridge_shadow.due_now(datetime(2026, 10, 30, 14, 0, tzinfo=UTC)) is True  # 10:00 ET
    assert bridge_shadow.due_now(datetime(2026, 10, 30, 14, 5, tzinfo=UTC)) is True
    assert bridge_shadow.due_now(datetime(2026, 10, 30, 14, 3, tzinfo=UTC)) is False
    assert bridge_shadow.due_now(datetime(2026, 10, 30, 13, 25, tzinfo=UTC)) is False  # 09:25 ET, before the open
    assert bridge_shadow.due_now(datetime(2026, 10, 30, 21, 0, tzinfo=UTC)) is False  # 17:00 ET, after the close
    assert bridge_shadow.due_now(datetime(2026, 10, 31, 14, 0, tzinfo=UTC)) is False  # Saturday


def test_a_run_logs_one_json_line_per_watchlist_symbol_and_a_summary(db_session, watchlist_with_items, caplog):
    caplog.set_level(logging.INFO)
    result = bridge_shadow.run(db_session, sources(), now=NOW)

    assert result.ok is True and result.ran is True
    lines = _lines(caplog)
    per_symbol = [line for line in lines if "symbol" in line]
    assert [line["symbol"] for line in per_symbol] == ["AAPL"]  # the future item is not shadowed
    assert per_symbol[0]["gap_bps"] == 0.0 and per_symbol[0]["quality_match"] is True
    assert per_symbol[0]["direct"]["provider"] == "alpaca" and per_symbol[0]["bridge"]["provider"] == "alpaca"
    assert {"direct_ms", "bridge_ms"} <= set(per_symbol[0])
    summary = next(line for line in lines if line.get("summary"))
    assert (summary["max_gap_bps"], summary["quality_mismatches"], summary["symbols"]) == (0.0, 0, 1)


def test_the_bridge_side_is_pinned_to_alpaca_the_same_feed_as_the_direct_path(db_session, watchlist_with_items, caplog):
    bridge = FakeBridge()
    bridge_shadow.run(db_session, sources(bridge=bridge), now=NOW)
    assert bridge.pins == [(("AAPL",), "alpaca")]


def test_a_price_gap_is_reported_in_basis_points_and_a_label_mismatch_is_flagged(
    db_session, watchlist_with_items, caplog
):
    caplog.set_level(logging.INFO)
    bridge = FakeBridge([quote(price=190.19, quality="realtime")])
    bridge_shadow.run(db_session, sources(bridge=bridge), now=NOW)

    line = next(entry for entry in _lines(caplog) if entry.get("symbol") == "AAPL")
    assert line["gap_bps"] == pytest.approx(10.0)
    assert line["quality_match"] is False
    summary = next(entry for entry in _lines(caplog) if entry.get("summary"))
    assert (summary["max_gap_bps"], summary["quality_mismatches"]) == (10.0, 1)


def test_a_symbol_one_side_could_not_quote_is_logged_as_missing_not_as_a_match(
    db_session, watchlist_with_items, caplog
):
    caplog.set_level(logging.INFO)
    bridge_shadow.run(db_session, sources(direct=FakeQuotes([])), now=NOW)
    line = next(entry for entry in _lines(caplog) if entry.get("symbol") == "AAPL")
    assert line["missing"] == "direct" and "gap_bps" not in line


def test_without_a_bridge_the_run_is_a_no_op(db_session, watchlist_with_items, caplog):
    caplog.set_level(logging.INFO)
    result = bridge_shadow.run(db_session, SimpleNamespace(quotes=FakeQuotes(), bridge=None), now=NOW)
    assert result.ran is False and result.ok is True
    assert _lines(caplog)[-1]["reason"] == "bridge_not_configured"


def test_an_empty_watchlist_is_a_no_op(db_session, caplog):
    caplog.set_level(logging.INFO)
    result = bridge_shadow.run(db_session, sources(), now=NOW)
    assert result.ran is False
    assert _lines(caplog)[-1]["reason"] == "empty_watchlist"


def test_a_provider_failure_is_logged_and_returned_not_raised(db_session, watchlist_with_items, caplog):
    caplog.set_level(logging.INFO)
    result = bridge_shadow.run(
        db_session, sources(bridge=FakeBridge(raises=Unavailable("bridge", "down"))), now=NOW
    )
    assert result.ok is False and "bridge" in (result.error or "")
    line = _lines(caplog)[-1]
    assert line["error"].startswith("bridge") and "Authorization" not in json.dumps(line)