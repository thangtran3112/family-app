"""`GET /status` with the IBKR gateway slot (02m §a3.1, §b4): the gateway state passes through, and a live
tick restamps `quotes` with IBKR's own quality and time -- never more than the gateway said. Needs a real
Postgres. The gateway here is a fake `GatewayStatusSource`; no connection of any kind is made."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pandas as pd
import pytest
from ai_trading_common.types import GatewayStatus
from conftest import auth_headers
from fakes import fake_data_sources

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.core.calendar import et
from ai_trading.db.models import FeedHealth, SymbolMetrics

IN_SESSION = et(datetime(2026, 10, 26).date(), "11:00").to_pydatetime()  # Monday 11:00 ET
TICK_AT = pd.Timestamp(IN_SESSION).tz_convert("UTC") - pd.Timedelta(seconds=3)


class FakeGatewaySource:
    def __init__(self, status: GatewayStatus) -> None:
        self._status = status

    def gateway_status(self) -> GatewayStatus:
        return self._status


def with_gateway(status: GatewayStatus):
    sources = fake_data_sources()
    object.__setattr__(sources, "quotes", SimpleNamespace(providers=(FakeGatewaySource(status),)))
    app.dependency_overrides[get_data_sources] = lambda: sources


@pytest.fixture
def clock(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    now = {"value": IN_SESSION}

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now["value"].astimezone(tz or UTC)

    monkeypatch.setattr("ai_trading.api.status.datetime", Frozen)
    return now


def _status(client) -> dict:
    response = client.get("/api/desk/status", headers=auth_headers())
    assert response.status_code == 200
    return response.json()


def test_without_a_gateway_the_row_is_not_configured_and_nothing_changes(client, db_session, clock):
    db_session.merge(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=IN_SESSION, updated_at=IN_SESSION))
    db_session.commit()
    body = _status(client)
    assert body["gateway"] == "not_configured"
    assert body["gateway_reason"] is None
    assert body["data_sources"]["quotes"] == "alpaca"
    assert body["quotes"]["source"] == "alpaca" and body["quotes"]["quality"] == "delayed-15m"
    assert body["streaming_slots"] == {"used": 0, "max": 70}


@pytest.mark.parametrize("state", ["down", "reconnecting"])
def test_a_gateway_that_is_not_connected_keeps_the_delayed_quotes_stamp(client, db_session, clock, state):
    db_session.merge(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=IN_SESSION, updated_at=IN_SESSION))
    db_session.commit()
    with_gateway(GatewayStatus(state, None, None))
    body = _status(client)
    assert body["gateway"] == state
    assert body["quotes"]["source"] == "alpaca" and body["quotes"]["quality"] == "delayed-15m"
    assert body["data_sources"]["quotes"] == "alpaca"


def test_a_live_tick_stamps_quotes_with_ibkrs_own_quality_and_time(client, clock):
    with_gateway(GatewayStatus("connected", "realtime", TICK_AT, 12))
    body = _status(client)
    assert body["gateway"] == "connected"
    # Per class, not one "mixed" guess (02t §5.5): quotes come from IBKR, everything else stays Alpaca.
    assert body["data_sources"]["quotes"] == "ibkr"
    assert body["streaming_slots"] == {"used": 12, "max": 70}
    quotes = body["quotes"]
    assert (quotes["source"], quotes["quality"], quotes["freshness"]) == ("ibkr", "realtime", "live")
    assert datetime.fromisoformat(quotes["as_of"].replace("Z", "+00:00")) == TICK_AT.to_pydatetime()


def test_a_delayed_gateway_tick_is_never_stamped_live(client, clock):
    with_gateway(GatewayStatus("connected", "delayed-15m", TICK_AT, 1))
    quotes = _status(client)["quotes"]
    assert (quotes["source"], quotes["quality"], quotes["freshness"]) == ("ibkr", "delayed-15m", "delayed")


def test_a_quiet_gateway_pauses_and_a_closed_market_reads_closed(client, clock):
    with_gateway(GatewayStatus("connected", "realtime", TICK_AT, 1))
    clock["value"] = IN_SESSION + pd.Timedelta(minutes=10)
    assert _status(client)["quotes"]["freshness"] == "paused"  # no tick for ten minutes in session
    clock["value"] = et(datetime(2026, 10, 27).date(), "03:00").to_pydatetime()  # overnight
    assert _status(client)["quotes"]["freshness"] == "closed"


def test_a_seeded_strip_gives_quotes_an_end_of_day_stamp_until_a_pass_has_run(client, db_session, clock):
    assert _status(client)["quotes"]["quality"] == "unavailable"  # nothing stored at all: no source claimed
    friday_close = datetime(2026, 10, 23, 20, 0, tzinfo=UTC)
    db_session.add(SymbolMetrics(symbol="SPY", as_of=friday_close, source="alpaca", quality="eod", metrics={}))
    db_session.merge(FeedHealth(feed="market_strip", state="ok", last_ok_at=IN_SESSION, updated_at=IN_SESSION))
    db_session.commit()
    body = _status(client)
    assert body["quotes"] == {
        "as_of": "2026-10-23T20:00:00Z",
        "source": "alpaca",
        "quality": "eod",
        "freshness": "delayed",
    }
    assert body["data_sources"]["quotes"] == "alpaca"
    assert body["scans"]["quality"] == "unavailable"  # no screener run stands behind a seed

    db_session.merge(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=IN_SESSION, updated_at=IN_SESSION))
    db_session.commit()
    assert _status(client)["quotes"]["quality"] == "delayed-15m"  # a real pass takes over
