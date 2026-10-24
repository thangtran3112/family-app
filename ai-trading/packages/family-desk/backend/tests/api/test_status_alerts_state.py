"""`GET /status` `alerts.state` on the real path (02m §a3.1): not started, running, paused for no quotes, and
paused by the user. The clock is frozen inside a regular session. Needs a real Postgres."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import auth_headers

from ai_trading.core.calendar import et
from ai_trading.db.models import FeedHealth

IN_SESSION = et(datetime(2026, 10, 6).date(), "11:00").to_pydatetime()  # Tuesday 11:00 ET
SPEC = {
    "schemaVersion": 1,
    "name": "Close above 100",
    "watch": {"universe": {"symbols": ["NVDA"]}, "session": "regular", "runOn": "bar_close_15m"},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
    "then": {"alert": {"channels": ["inbox"]}},
}


@pytest.fixture
def clock(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    now = {"value": IN_SESSION}

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now["value"].astimezone(tz or UTC)

    monkeypatch.setattr("ai_trading.api.status.datetime", Frozen)
    monkeypatch.setattr("ai_trading.api.alert_strategies.datetime", Frozen)
    return now


def _state(client) -> str:
    return client.get("/api/desk/status", headers=auth_headers()).json()["alerts"]["state"]


def test_the_state_follows_the_strategies_the_feed_and_the_pause(client, db_session, clock):
    assert _state(client) == "not_started"
    created = client.post("/api/desk/alert-strategies", json={"spec": SPEC, "save_as": "on"}, headers=auth_headers())
    assert created.status_code == 201
    assert _state(client) == "paused_no_quotes"  # a live strategy and a bars feed that never ran

    db_session.merge(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=IN_SESSION, updated_at=IN_SESSION))
    db_session.commit()
    assert _state(client) == "running"

    clock["value"] = IN_SESSION + timedelta(hours=1)
    assert _state(client) == "paused_no_quotes"  # the feed stopped an hour ago, in session

    client.put("/api/desk/settings", json={"settings": {"pause_all": True}}, headers=auth_headers())
    assert _state(client) == "paused_by_user"
