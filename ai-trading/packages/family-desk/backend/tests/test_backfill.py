"""The backfill glue module: fills missing sessions for one symbol/timeframe from Alpaca,
through the bar store. Needs a real Postgres (`scripts/test-db.sh`); the HTTP layer is a fake
serving the recorded Alpaca fixtures (and, for the pre-2016 and error scenarios below, small
hand-built bodies in the same real Alpaca response shape, since no recorded fixture spans the
2016 boundary or a 5xx)."""

import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.providers.alpaca import AlpacaBars
from ai_trading_common.testing import FakeResponse, make_client

from ai_trading.core.calendar import et
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START, backfill
from ai_trading.data.bars import read_bars, upsert_bars

FIXTURES = Path(__file__).parent / "fixtures" / "alpaca"

DAY = date(2026, 10, 6)  # a regular XNYS session (shared with test_bars_store.py)
NEXT_DAY = date(2026, 10, 7)
THIRD_DAY = date(2026, 10, 8)


def load_daily_range_aapl() -> dict:
    return json.loads((FIXTURES / "daily_range_aapl.json").read_text())["body"]


def _alpaca_from(*responses) -> tuple[AlpacaBars, object]:
    client, session, _ = make_client(list(responses))
    return AlpacaBars("kid", "sec", http=client), session


def _bar(day_iso: str, price: float = 100.0) -> dict:
    return {"o": price, "h": price, "l": price, "c": price, "v": 1_000.0, "t": f"{day_iso}T14:30:00Z"}


class TestFillsFromARecordedFixture:
    def test_one_contiguous_range_is_one_http_call(self, db_session):
        # The recorded fixture's own range (2026-01-02..01-14); drop_unclosed naturally trims
        # it to just the two requested days once `now` is set right after the second closes.
        alpaca, session_ = _alpaca_from(FakeResponse(200, load_daily_range_aapl()))
        start, end = date(2026, 1, 2), date(2026, 1, 5)
        now = et(end, "20:00")

        result = backfill(db_session, "AAPL", "1d", "stock", start, end, bars_source=alpaca, now=now)
        db_session.commit()

        assert result.requested == (start, end)
        assert result.written == [start, end]
        assert result.uncovered == []
        assert len(session_.calls) == 1

        got = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
        assert list(got.index) == [start, end]
        assert list(got["close"]) == [270.27, 266.53]


class TestClampsPre2016History:
    def test_sessions_before_the_free_history_start_are_uncovered_not_fetched(self, db_session):
        start, end = date(2015, 12, 30), date(2016, 1, 5)
        assert ALPACA_FREE_HISTORY_START == date(2016, 1, 1)
        body = {
            "bars": [_bar("2016-01-04"), _bar("2016-01-05")],
            "next_page_token": None,
            "symbol": "AAPL",
        }
        alpaca, session_ = _alpaca_from(FakeResponse(200, body))
        now = et(end, "20:00")

        result = backfill(db_session, "AAPL", "1d", "stock", start, end, bars_source=alpaca, now=now)
        db_session.commit()

        assert result.uncovered == [date(2015, 12, 30), date(2015, 12, 31)]
        assert result.written == [date(2016, 1, 4), date(2016, 1, 5)]
        assert len(session_.calls) == 1  # the clamped range never reaches the provider

        got = read_bars(db_session, "AAPL", "1d", start, end, "stock", as_of=now)
        assert list(got.index) == [date(2016, 1, 4), date(2016, 1, 5)]


class TestProviderErrorMidway:
    def test_an_unavailable_range_leaves_earlier_writes_intact_and_names_where_it_stopped(self, db_session):
        # A session already stored (NEXT_DAY) splits [DAY, THIRD_DAY] into two separate
        # contiguous ranges, so the fake HTTP layer sees exactly two calls: one per range.
        now = et(THIRD_DAY, "20:00")
        upsert_bars(db_session, "AAPL", "1d", _frame_for(NEXT_DAY, 200.0), "alpaca", "stock", now=now)
        db_session.commit()

        first_range_body = {"bars": [_bar(DAY.isoformat(), 150.0)], "next_page_token": None, "symbol": "AAPL"}
        failing_responses = [FakeResponse(500, {}) for _ in range(4)]  # exhausts ThrottledClient's 3 retries
        alpaca, session_ = _alpaca_from(FakeResponse(200, first_range_body), *failing_responses)

        with pytest.raises(Unavailable) as excinfo:
            backfill(db_session, "AAPL", "1d", "stock", DAY, THIRD_DAY, bars_source=alpaca, now=now)
        db_session.commit()

        assert any("backfill stopped" in note for note in excinfo.value.__notes__)
        assert len(session_.calls) == 1 + 4  # the successful first range, then the exhausted retries

        got = read_bars(db_session, "AAPL", "1d", DAY, THIRD_DAY, "stock", as_of=now)
        assert list(got.index) == [DAY, NEXT_DAY]  # DAY written before the failure; THIRD_DAY never reached
        assert list(got["close"]) == [150.0, 200.0]


def _frame_for(day: date, price: float) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": [price], "high": [price], "low": [price], "close": [price], "volume": [1_000.0]},
        index=pd.Index([day]),
    )
