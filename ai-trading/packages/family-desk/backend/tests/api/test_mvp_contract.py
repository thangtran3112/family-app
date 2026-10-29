"""Contract fixtures of the technical desktop MVP (02m §a4, §d3): with the stub on, every new or extended
endpoint is called once and its JSON body is compared with the checked-in file under
`tests/fixtures/desk-mvp/api/`. Those files are the response shapes stream F's loader tests parse
(`frontend/lib/fixtures/desk-mvp/`, copied by a script), so a model change that alters a body fails here
until the files are regenerated and reviewed:

    UPDATE_DESK_MVP_FIXTURES=1 uv run pytest tests/api/test_mvp_contract.py
"""

import json
import os
from pathlib import Path
from typing import Any

import pytest
from conftest import OWNER_EMAIL, auth_headers
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from ai_trading.cli.seed_technical import seed_email
from ai_trading.mvp_stub import world

API_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "desk-mvp" / "api"
UPDATE = os.environ.get("UPDATE_DESK_MVP_FIXTURES") == "1"

_ABNORMAL_VOLUME = {
    "schemaVersion": 1,
    "name": "Abnormal volume",
    "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": "bar_close_15m"},
    "liquidity": {"minPrice": 5, "minAvgVolume": 500000},
    "when": {"op": "gte", "left": {"series": "rvol", "lookbackDays": 10}, "right": {"value": 2.5}},
    "rank": {"by": {"series": "rvol", "lookbackDays": 10}, "order": "desc"},
    "maxResults": 50,
}
_BROKEN_ALERT = {**world.alert_strategies()[0]["spec"], "then": {"alert": {"channels": ["telegram"]}}}

#: (fixture name, method, url, JSON body or None, expected status)
CASES: list[tuple[str, str, str, Any, int]] = [
    ("status", "GET", "/api/desk/status", None, 200),
    ("symbols_search", "GET", "/api/desk/symbols/search?q=NV", None, 200),
    ("dashboard", "GET", "/api/desk/dashboard", None, 200),
    ("bars_nvda_15m", "GET", "/api/desk/bars/NVDA?interval=15m&days=5", None, 200),
    ("bars_nvda_1d", "GET", "/api/desk/bars/NVDA?interval=1d&days=30", None, 200),
    ("bars_nvda_5m_extended", "GET", "/api/desk/bars/NVDA?interval=5m&days=3&session=extended", None, 200),
    ("technicals_nvda_15m", "GET", "/api/desk/technicals/NVDA?timeframe=15m", None, 200),
    ("technicals_spy_1d", "GET", "/api/desk/technicals/SPY?timeframe=1d", None, 200),
    ("chart_markers_msft_15m", "GET", "/api/desk/charts/MSFT/markers?timeframe=15m&all_patterns=true", None, 200),
    ("signals", "GET", "/api/desk/signals", None, 200),
    ("screener_filters", "GET", "/api/desk/screener/filters", None, 200),
    ("screener_filter_1", "GET", "/api/desk/screener/filters/1", None, 200),
    ("screener_filter_1_results", "GET", "/api/desk/screener/filters/1/results", None, 200),
    ("screener_universe", "GET", "/api/desk/screener/universe", None, 200),
    ("screener_preview", "POST", "/api/desk/screener/preview", {"spec": _ABNORMAL_VOLUME}, 200),
    ("screener_filter_copy", "POST", "/api/desk/screener/filters", {"copy_of": 1}, 201),
    ("watchlists", "GET", "/api/desk/watchlists", None, 200),
    ("watchlist_1_table", "GET", "/api/desk/watchlists/1/table", None, 200),
    ("library", "GET", "/api/desk/library", None, 200),
    ("library_hammer", "GET", "/api/desk/library/hammer", None, 200),
    ("library_attach", "POST", "/api/desk/library/hammer/attach", {"watchlist_id": 1}, 201),
    ("alert_strategies", "GET", "/api/desk/alert-strategies", None, 200),
    ("alert_strategy_2", "GET", "/api/desk/alert-strategies/2", None, 200),
    ("alert_strategy_2_fires", "GET", "/api/desk/alert-strategies/2/fires", None, 200),
    (
        "alert_strategy_validate",
        "POST",
        "/api/desk/alert-strategies/validate",
        {"spec": world.alert_strategies()[0]["spec"]},
        200,
    ),
    ("alert_strategy_validate_problem", "POST", "/api/desk/alert-strategies/validate", {"spec": _BROKEN_ALERT}, 200),
    (
        "alert_strategy_create_422",
        "POST",
        "/api/desk/alert-strategies",
        {"spec": _BROKEN_ALERT, "save_as": "draft"},
        422,
    ),
    ("alerts", "GET", "/api/desk/alerts", None, 200),
    ("alerts_log", "GET", "/api/desk/alerts/log", None, 200),
    ("settings_channels", "GET", "/api/desk/settings/channels", None, 200),
]


@pytest.fixture
def seeded(client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A fresh database seeded for the owner: identities restart, so the seeded ids are the stub world's
    (watchlists 1-2, filters 1-10, alert strategies 1-5)."""
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    monkeypatch.delenv(
        "DESK_FUNDAMENTAL_STUB", raising=False
    )  # the Fundamental fields of `status` read as not connected
    monkeypatch.delenv("IBKR_FLEX_TOKEN", raising=False)
    monkeypatch.delenv("IBKR_FLEX_QUERY_ID", raising=False)
    db_session.execute(text("TRUNCATE users, watchlists, filter_strategies, strategies RESTART IDENTITY CASCADE"))
    db_session.commit()
    seed_email(db_session, OWNER_EMAIL)
    db_session.commit()
    return client


@pytest.mark.parametrize(("name", "method", "url", "body", "status"), CASES, ids=[c[0] for c in CASES])
def test_stub_response_matches_the_checked_in_fixture(
    seeded: TestClient, name: str, method: str, url: str, body: Any, status: int
) -> None:
    response = seeded.request(method, url, json=body, headers=auth_headers())
    assert response.status_code == status, response.text
    rendered = json.dumps(response.json(), indent=1, sort_keys=True) + "\n"
    path = API_FIXTURES / f"{name}.json"
    if UPDATE:
        path.write_text(rendered)
    assert path.read_text() == rendered


def test_every_checked_in_fixture_has_a_case() -> None:
    assert {p.stem for p in API_FIXTURES.glob("*.json")} == {c[0] for c in CASES}
