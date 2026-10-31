"""`GET/PUT /api/desk/settings/market-data` (02t §6): the card's states, the owner-only rule, and the 422 /
saved-with-warning behaviours. A fake bridge and a real Postgres routing row; no network.
"""

from datetime import UTC, datetime

import pytest
from ai_trading_common.errors import Unavailable
from ai_trading_common.types import ClassRouting, ProviderHealth, Routing
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from fakes import fake_data_sources

from ai_trading.api.app import app
from ai_trading.api.auth import get_data_sources
from ai_trading.data import routing as routing_store
from ai_trading.db.models import MarketDataRouting

IBKR_OK = ProviderHealth(provider="ibkr", classes=("equity_quotes",), configured=True, state="ok", quality="realtime")
IBKR_OFF = ProviderHealth(
    provider="ibkr", classes=("equity_quotes",), configured=True, state="off", reason="off", quality="delayed-15m"
)
IBKR_NO_KEY = ProviderHealth(provider="ibkr", classes=("equity_quotes",), configured=False, state="not_configured")
ALPACA = ProviderHealth(
    provider="alpaca",
    classes=("equity_quotes", "equity_bars"),
    configured=True,
    state="ok",
    quality="delayed-15m",
)


def routing(preferred: str = "", version: int = 0, source: str = "env_default") -> Routing:
    return Routing(
        classes=(
            ClassRouting("equity_quotes", preferred, ("ibkr", "alpaca"), "alpaca"),
            ClassRouting("equity_bars", "", ("alpaca",), "alpaca"),
        ),
        version=version,
        source=source,  # type: ignore[arg-type]
    )


class FakeBridge:
    def __init__(self, *, health=None, current=None, raises=None, applied=None) -> None:
        self.health = health if health is not None else [IBKR_OFF, ALPACA]
        self.current = current or routing()
        self.raises = raises
        self.applied = applied
        self.sent: list[tuple[dict, int]] = []

    def healthz(self) -> bool:
        return self.raises is None

    def providers(self):
        if self.raises is not None:
            raise self.raises
        return self.health

    def routing(self):
        if self.raises is not None:
            raise self.raises
        return self.current

    def set_routing(self, preferences, version):
        if self.raises is not None:
            raise self.raises
        self.sent.append((dict(preferences), version))
        if self.applied is not None:
            return self.applied
        # Mirrors the bridge: the preference moves to the head of the ladder, and the first rung whose health
        # is usable serves (a configured-but-off provider falls through, which is what the §6 warning is for).
        preferred = preferences.get("equity_quotes", "")
        health = {row.provider: row for row in self.health}
        serving = "alpaca"
        for name in ([preferred] if preferred else []) + ["ibkr", "alpaca"]:
            row = health.get(name)
            if row is not None and row.configured and row.state in {"ok", "degraded"}:
                serving = name
                break
        return Routing(
            classes=(
                ClassRouting("equity_quotes", preferred, ("ibkr", "alpaca"), serving),
                ClassRouting("equity_bars", "", ("alpaca",), "alpaca"),
            ),
            version=version,
            source="desk",
        )


def use(bridge) -> None:
    sources = fake_data_sources()
    object.__setattr__(sources, "bridge", bridge)
    object.__setattr__(
        sources,
        "serving",
        {
            "quotes": "alpaca",
            "bars": "alpaca",
            "option_chain": "alpaca_options",
            "trades": "alpaca",
            "universe": "alpaca",
        },
    )
    app.dependency_overrides[get_data_sources] = lambda: sources


@pytest.fixture
def owner_env(monkeypatch):
    monkeypatch.setenv("DESK_OWNER_EMAILS", f" {OWNER_EMAIL.upper()} , someone@example.com ")


def _card(client, email=OWNER_EMAIL) -> dict:
    response = client.get("/api/desk/settings/market-data", headers=auth_headers(email))
    assert response.status_code == 200, response.text
    return response.json()


def test_the_card_is_in_shadow_mode_and_names_all_four_providers(client, owner_env):
    use(FakeBridge())
    card = _card(client)
    assert (card["shadow"], card["owner"], card["available"]) == (True, True, True)
    assert card["desk_serving"] == "alpaca"
    classes = {row["data_class"]: row for row in card["classes"]}
    assert list(classes) == ["equity_quotes", "equity_bars", "option_chain"]
    quotes = classes["equity_quotes"]
    assert (quotes["ladder"], quotes["serving"], quotes["preferred"]) == (["ibkr", "alpaca"], "alpaca", "")
    assert [option["provider"] for option in quotes["options"]] == ["ibkr", "longbridge", "alpaca", "marketdata_app"]
    assert [option["in_ladder"] for option in quotes["options"]] == [True, False, True, False]
    assert classes["equity_bars"]["preferred"] == ""


def test_the_wife_sees_the_same_card_read_only(client, owner_env):
    use(FakeBridge())
    card = _card(client, OTHER_EMAIL)
    assert card["owner"] is False
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "alpaca"},
        headers=auth_headers(OTHER_EMAIL),
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Only the owner changes data providers"


def test_a_stored_preference_shows_as_your_choice(client, owner_env, db_session):
    routing_store.record(
        db_session, data_class="equity_quotes", provider="ibkr", updated_by=OWNER_EMAIL, now=datetime.now(UTC)
    )
    db_session.commit()
    use(FakeBridge(current=routing("ibkr", 1, "desk")))
    quotes = {row["data_class"]: row for row in _card(client)["classes"]}["equity_quotes"]
    assert quotes["preferred"] == "ibkr"
    assert _card(client)["reason"] is None


def test_an_unsynced_bridge_reports_routing_syncing(client, owner_env, db_session):
    routing_store.record(
        db_session, data_class="equity_quotes", provider="alpaca", updated_by=OWNER_EMAIL, now=datetime.now(UTC)
    )
    db_session.commit()
    use(FakeBridge(current=routing("", 0, "env_default")))
    card = _card(client)
    assert (card["reason"], card["routing_source"]) == ("routing_syncing", "env_default")


def test_an_unknown_provider_is_a_422_with_words(client, owner_env):
    use(FakeBridge())
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "tradier"},
        headers=auth_headers(),
    )
    assert response.status_code == 422
    assert "not a provider the Desk offers" in response.json()["detail"]


def test_a_provider_outside_the_ladder_is_a_422_naming_the_ladder(client, owner_env):
    use(FakeBridge())
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "longbridge"},
        headers=auth_headers(),
    )
    assert response.status_code == 422
    assert "not in the stock quotes ladder on the bridge (ibkr, alpaca)" in response.json()["detail"]


def test_a_provider_without_a_key_is_a_422_and_nothing_is_stored(client, owner_env, db_session):
    use(FakeBridge(health=[IBKR_NO_KEY, ALPACA], current=routing()))
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "ibkr"},
        headers=auth_headers(),
    )
    assert response.status_code == 422
    assert "has no key on the bridge yet" in response.json()["detail"]
    assert db_session.query(MarketDataRouting).count() == 0


def test_a_configured_but_down_choice_saves_with_the_section_six_warning(client, owner_env, db_session):
    bridge = FakeBridge(health=[IBKR_OFF, ALPACA], current=routing())
    use(bridge)
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "ibkr"},
        headers=auth_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["warning"] == "Saved. IBKR is off right now, so Alpaca serves until it's back."
    assert bridge.sent == [({"equity_quotes": "ibkr"}, 1)]
    row = db_session.get(MarketDataRouting, "equity_quotes")
    assert (row.preferred, row.version, row.updated_by) == ("ibkr", 1, OWNER_EMAIL)


def test_a_healthy_choice_saves_without_a_warning(client, owner_env):
    use(FakeBridge(health=[IBKR_OK, ALPACA]))
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "ibkr"},
        headers=auth_headers(),
    )
    assert response.status_code == 200
    assert response.json()["warning"] is None


def test_clearing_the_preference_returns_the_class_to_the_ladder(client, owner_env, db_session):
    bridge = FakeBridge(health=[IBKR_OK, ALPACA])
    use(bridge)
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": ""},
        headers=auth_headers(),
    )
    assert response.status_code == 200
    assert bridge.sent == [({"equity_quotes": ""}, 1)]
    assert db_session.get(MarketDataRouting, "equity_quotes").preferred is None


def test_a_bridge_that_does_not_answer_is_a_503_and_nothing_is_stored(client, owner_env, db_session):
    use(FakeBridge(raises=Unavailable("bridge", "down")))
    response = client.put(
        "/api/desk/settings/market-data",
        json={"data_class": "equity_quotes", "provider": "alpaca"},
        headers=auth_headers(),
    )
    assert response.status_code == 503
    assert db_session.query(MarketDataRouting).count() == 0


def test_the_card_says_not_reachable_instead_of_failing(client, owner_env):
    use(FakeBridge(raises=Unavailable("bridge", "down")))
    card = _card(client)
    assert (card["available"], card["reason"]) == (False, "bridge_unreachable")


def test_without_a_configured_bridge_the_card_is_honest(client, owner_env):
    use(None)
    card = _card(client)
    assert (card["available"], card["reason"]) == (False, "bridge_not_configured")
    assert card["classes"][0]["ladder"] == []
