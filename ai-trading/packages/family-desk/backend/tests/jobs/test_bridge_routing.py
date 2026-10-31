"""`bridge_routing` (02t §3.5): the 60-second reconciler that re-sends the Desk's preference after a bridge
restart. Fake bridge, real Postgres row.
"""

import json
import logging
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.types import ClassRouting, Routing

from ai_trading.data import routing as routing_store
from ai_trading.jobs import bridge_routing

NOW = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _logger_on(monkeypatch):
    # Alembic's `fileConfig` (run by the DB fixtures) disables every logger that already exists.
    monkeypatch.setattr(bridge_routing.logger, "disabled", False)


def routing(version: int, source: str = "desk", preferred: str = "") -> Routing:
    return Routing(
        classes=(ClassRouting("equity_quotes", preferred, ("ibkr", "alpaca"), "alpaca"),),
        version=version,
        source=source,  # type: ignore[arg-type]
    )


class FakeBridge:
    def __init__(self, current: Routing, *, raises=None) -> None:
        self.current = current
        self.raises = raises
        self.sent: list[tuple[dict, int]] = []

    def routing(self) -> Routing:
        if self.raises is not None:
            raise self.raises
        return self.current

    def set_routing(self, preferences, version):
        self.sent.append((dict(preferences), version))
        return self.current


def _lines(caplog) -> list[dict]:
    return [json.loads(r.getMessage()) for r in caplog.records if r.name == "ai_trading.jobs.bridge_routing"]


def test_due_now_is_every_tick():
    assert bridge_routing.due_now(NOW) is True


def test_before_the_toggle_is_ever_used_there_is_nothing_to_sync(db_session):
    bridge = FakeBridge(routing(0, "env_default"))
    result = bridge_routing.run(db_session, SimpleNamespace(bridge=bridge), now=NOW)
    assert result.ran is False and bridge.sent == []


def test_a_bridge_still_on_its_env_default_is_told_the_stored_preference(db_session, caplog):
    caplog.set_level(logging.INFO)
    routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by="owner@example.test", now=NOW
    )
    db_session.commit()
    bridge = FakeBridge(routing(0, "env_default"))
    result = bridge_routing.run(db_session, SimpleNamespace(bridge=bridge), now=NOW)

    assert result.ok is True
    assert bridge.sent == [({"equity_quotes": "ibkr"}, 1)]
    assert _lines(caplog)[-1]["synced"] is True


def test_a_bridge_already_at_the_desks_version_is_left_alone(db_session):
    routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by="owner@example.test", now=NOW
    )
    db_session.commit()
    bridge = FakeBridge(routing(1))
    assert bridge_routing.run(db_session, SimpleNamespace(bridge=bridge), now=NOW).ran is False
    assert bridge.sent == []


def test_a_bridge_that_rejects_the_choice_is_a_failed_run_not_a_crash(db_session, caplog):
    caplog.set_level(logging.INFO)
    routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by="owner@example.test", now=NOW
    )
    db_session.commit()
    bridge = FakeBridge(routing(1), raises=Unavailable("bridge", "down"))
    result = bridge_routing.run(db_session, SimpleNamespace(bridge=bridge), now=NOW)

    assert result.ok is False
    assert _lines(caplog)[-1]["error"].startswith("bridge")


def test_no_bridge_configured_is_a_no_op(db_session):
    assert bridge_routing.run(db_session, SimpleNamespace(bridge=None), now=NOW).ran is False