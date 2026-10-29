"""Contract fixtures of the Desktop Fundamental lane (02n §h step 3b, the 02m §a4 pattern of `test_mvp_contract.py`):
with `DESK_FUNDAMENTAL_STUB=1` every new or extended endpoint is called once and its JSON body is compared with the
checked-in file under `tests/fixtures/desk-fundamental/api/`. Those files are the response shapes stream F's loader
tests parse, so a model or world change that alters a body fails here until the files are regenerated and reviewed:

    UPDATE_DESK_FUNDAMENTAL_FIXTURES=1 uv run pytest tests/api/test_fundamental_contract.py

Every value in them is invented (`fundamental_stub/world.py`): the repository is public.
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

from ai_trading.db.models import User, Watchlist, WatchlistItem

API_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "desk-fundamental" / "api"
UPDATE = os.environ.get("UPDATE_DESK_FUNDAMENTAL_FIXTURES") == "1"
PREFIX = "/api/desk"

#: (fixture name, method, url, JSON body or None, expected status)
CASES: list[tuple[str, str, str, Any, int]] = [
    ("dashboard_fundamental", "GET", f"{PREFIX}/dashboard/fundamental", None, 200),
    ("holdings", "GET", f"{PREFIX}/holdings", None, 200),
    ("holdings_account_2", "GET", f"{PREFIX}/holdings?account_id=2", None, 200),
    ("holdings_lots_aapl", "GET", f"{PREFIX}/holdings/AAPL/lots", None, 200),
    ("holdings_import", "POST", f"{PREFIX}/holdings/import", None, 202),
    ("account_patch", "PATCH", f"{PREFIX}/accounts/2", {"label": "Roth IRA", "type": "roth"}, 200),
    ("covered_calls_coverage", "GET", f"{PREFIX}/covered-calls/coverage", None, 200),
    (
        "covered_calls_candidates_aapl_1",
        "GET",
        f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id=1",
        None,
        200,
    ),
    (
        "covered_calls_candidates_aapl_2",
        "GET",
        f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id=2",
        None,
        200,
    ),
    ("covered_calls_candidates_ko", "GET", f"{PREFIX}/covered-calls/candidates?symbol=KO", None, 200),
    ("covered_calls_short_calls", "GET", f"{PREFIX}/covered-calls/short-calls", None, 200),
    ("covered_calls_roll_ko", "GET", f"{PREFIX}/covered-calls/short-calls/9/roll", None, 200),
    ("covered_calls_roll_jnj", "GET", f"{PREFIX}/covered-calls/short-calls/10/roll", None, 200),
    ("covered_calls_income", "GET", f"{PREFIX}/covered-calls/income", None, 200),
    ("covered_calls_income_3", "GET", f"{PREFIX}/covered-calls/income?months=3", None, 200),
    ("futures_readings", "GET", f"{PREFIX}/futures/readings", None, 200),
    ("research_brief", "GET", f"{PREFIX}/research/brief", None, 200),
    ("research_aapl", "GET", f"{PREFIX}/research/symbols/AAPL", None, 200),
    ("research_jnj", "GET", f"{PREFIX}/research/symbols/JNJ", None, 200),
    ("research_valuation_aapl", "GET", f"{PREFIX}/research/symbols/AAPL/valuation", None, 200),
    ("research_valuation_nvda", "GET", f"{PREFIX}/research/symbols/NVDA/valuation", None, 200),
    ("research_timeline_ko", "GET", f"{PREFIX}/research/symbols/KO/timeline", None, 200),
    ("research_timeline_ko_news", "GET", f"{PREFIX}/research/symbols/KO/timeline?kind=news&limit=1", None, 200),
    ("fundamental_alerts", "GET", f"{PREFIX}/fundamental-alerts", None, 200),
    (
        "fundamental_alert_put",
        "PUT",
        f"{PREFIX}/fundamental-alerts/ai_daily_view",
        {"enabled": True, "rules": {"confidence_below": 40}},
        200,
    ),
    (
        "fundamental_alert_put_422",
        "PUT",
        f"{PREFIX}/fundamental-alerts/short_call_risk",
        {"rules": {"delta_above": True, "colour": 3}},
        422,
    ),
    ("account_patch_422", "PATCH", f"{PREFIX}/accounts/1", {}, 422),
]


@pytest.fixture
def stubbed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DESK_FUNDAMENTAL_STUB", "1")
    return client


def _check(name: str, response: Any) -> None:
    rendered = json.dumps(response.json(), indent=1, sort_keys=True) + "\n"
    path = API_FIXTURES / f"{name}.json"
    if UPDATE:
        path.write_text(rendered)
    assert path.read_text() == rendered


@pytest.mark.parametrize(("name", "method", "url", "body", "status"), CASES, ids=[c[0] for c in CASES])
def test_stub_response_matches_the_checked_in_fixture(
    stubbed: TestClient, name: str, method: str, url: str, body: Any, status: int
) -> None:
    response = stubbed.request(method, url, json=body, headers=auth_headers())
    assert response.status_code == status, response.text
    _check(name, response)


def test_status_carries_the_three_fundamental_fields(stubbed: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """`GET /status` is the real route (its clock-dependent fields vary); the fixture holds the three new fields."""
    body = stubbed.get(f"{PREFIX}/status", headers=auth_headers()).json()
    fields = {key: body[key] for key in ("holdings", "options", "ai_daily")}
    path = API_FIXTURES / "status_fundamental_fields.json"
    rendered = json.dumps(fields, indent=1, sort_keys=True) + "\n"
    if UPDATE:
        path.write_text(rendered)
    assert path.read_text() == rendered


def test_long_term_watchlist_rows_carry_fundamentals(stubbed: TestClient, db_session: Session) -> None:
    db_session.execute(text("TRUNCATE users, watchlists RESTART IDENTITY CASCADE"))  # the fixture holds list id 1
    user = User(email=OWNER_EMAIL, settings={})
    db_session.add(user)
    db_session.flush()
    lists = {}
    for name, horizon in (("Long", "long_term"), ("Swing", "swing")):
        lists[horizon] = Watchlist(user_id=user.id, name=name, horizon=horizon)
        db_session.add(lists[horizon])
    db_session.flush()
    for watchlist in lists.values():
        for position, symbol in enumerate(("AAPL", "ZZZZ")):
            db_session.add(
                WatchlistItem(watchlist_id=watchlist.id, symbol=symbol, asset_type="stock", position=position)
            )
    db_session.commit()

    long_term = stubbed.get(f"{PREFIX}/watchlists/{lists['long_term'].id}/table", headers=auth_headers())
    assert long_term.status_code == 200, long_term.text
    _check("watchlist_long_term_table", long_term)
    swing = stubbed.get(f"{PREFIX}/watchlists/{lists['swing'].id}/table", headers=auth_headers()).json()
    assert all("fundamentals" not in row for row in swing["rows"])


def test_every_checked_in_fixture_has_a_case() -> None:
    expected = {c[0] for c in CASES} | {"status_fundamental_fields", "watchlist_long_term_table"}
    assert {p.stem for p in API_FIXTURES.glob("*.json")} == expected
