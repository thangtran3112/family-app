"""Behaviour of the Fundamental contract-first stubs (02n §h step 3b): off by default and serving nothing fake when off,
the right shape and labels when on, the engine's numbers, and the privacy rules of §c1 (no broker account number or
email in any response or schema). The byte-for-byte bodies are `test_fundamental_contract.py`'s."""

import inspect
import json
import re
from pathlib import Path
from typing import Any

import pytest
from conftest import auth_headers
from fastapi.testclient import TestClient
from pydantic import BaseModel

from ai_trading.api.app import app
from ai_trading.api.schemas import fundamental as fundamental_schemas
from ai_trading.core import covered_calls as engine
from ai_trading.fundamental_stub import STUB_FLAG, stub_enabled
from ai_trading.fundamental_stub import world as w

PREFIX = "/api/desk"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "desk-fundamental" / "api"
STUB_SOURCE = Path(inspect.getfile(stub_enabled)).parent

#: The 17 new routes (02n §c2 rows 1-17): (method, url, JSON body). Every one is 503 while the flag is off.
NEW_ROUTES: list[tuple[str, str, Any]] = [
    ("GET", f"{PREFIX}/dashboard/fundamental", None),
    ("GET", f"{PREFIX}/holdings", None),
    ("GET", f"{PREFIX}/holdings/AAPL/lots", None),
    ("POST", f"{PREFIX}/holdings/import", None),
    ("PATCH", f"{PREFIX}/accounts/1", {"label": "Main"}),
    ("GET", f"{PREFIX}/covered-calls/coverage", None),
    ("GET", f"{PREFIX}/covered-calls/candidates?symbol=AAPL", None),
    ("GET", f"{PREFIX}/covered-calls/short-calls", None),
    ("GET", f"{PREFIX}/covered-calls/short-calls/8/roll", None),
    ("GET", f"{PREFIX}/covered-calls/income", None),
    ("GET", f"{PREFIX}/futures/readings", None),
    ("GET", f"{PREFIX}/research/brief", None),
    ("GET", f"{PREFIX}/research/symbols/AAPL", None),
    ("GET", f"{PREFIX}/research/symbols/AAPL/valuation", None),
    ("GET", f"{PREFIX}/research/symbols/AAPL/timeline", None),
    ("GET", f"{PREFIX}/fundamental-alerts", None),
    ("PUT", f"{PREFIX}/fundamental-alerts/ai_daily_view", {"enabled": True}),
]
IDS = [f"{method} {url.removeprefix(PREFIX)}" for method, url, _ in NEW_ROUTES]

#: What an IBKR account number looks like (`U1234567`, `DU1234567`, `F1234567`), and an email.
_ACCOUNT_NUMBER = re.compile(r"\b(?:DU|U|F|I)\d{6,9}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_FORBIDDEN_KEYS = {"external_id", "account_number", "account_no", "account_num", "email", "broker_account"}


def get(client: TestClient, url: str, **kwargs: Any) -> Any:
    return client.get(url, headers=auth_headers(), **kwargs)


@pytest.fixture
def stubbed(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv(STUB_FLAG, "1")
    return client


@pytest.mark.parametrize(
    ("value", "expected"), [("1", True), ("0", False), ("true", False), ("", False), (None, False)]
)
def test_only_exactly_one_turns_the_fundamental_stub_on(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: bool
) -> None:
    if value is None:
        monkeypatch.delenv(STUB_FLAG, raising=False)
    else:
        monkeypatch.setenv(STUB_FLAG, value)
    assert stub_enabled() is expected


#: The routes still without a real service with the flag off (02n §h step 3c): the Today aggregate, the futures
#: readings (deferred, 02b §4b) and the alert templates (the step-5 scoring). Holdings, covered calls and research are
#: real now: `test_holdings_real.py`, `test_covered_calls_real.py` and `test_research_real.py` cover them.
GATED_ROUTES = [
    route
    for route in NEW_ROUTES
    if route[1].split(PREFIX)[1].split("?")[0]
    in (
        "/dashboard/fundamental",
        "/futures/readings",
        "/fundamental-alerts",
        "/fundamental-alerts/ai_daily_view",
    )
]
GATED_IDS = [f"{method} {url.removeprefix(PREFIX)}" for method, url, _ in GATED_ROUTES]


def test_the_gated_routes_are_the_four_with_no_real_service_yet() -> None:
    assert len(GATED_ROUTES) == 4 and len(NEW_ROUTES) - len(GATED_ROUTES) == 13


@pytest.mark.parametrize(("method", "url", "body"), GATED_ROUTES, ids=GATED_IDS)
def test_with_the_flag_off_a_gated_route_serves_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, method: str, url: str, body: Any
) -> None:
    monkeypatch.delenv(STUB_FLAG, raising=False)
    response = client.request(method, url, json=body, headers=auth_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "not available yet"}


def test_with_the_flag_off_status_says_nothing_is_connected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(STUB_FLAG, raising=False)
    for name in ("IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"):
        monkeypatch.delenv(name, raising=False)
    body = get(client, f"{PREFIX}/status").json()
    assert body["holdings"] == {
        "source": "ibkr_flex",
        "account_scope": "data",
        "statement_date": None,
        "imported_at": None,
        "lots": 0,
        "state": "not_configured",
    }
    assert body["options"] == {
        "as_of": None,
        "source": None,
        "quality": "unavailable",
        "freshness": "unavailable",
        "state": "not_connected",
    }
    assert body["ai_daily"] == {"state": "not_started", "last_run_at": None}


def test_with_the_flag_off_status_knows_a_configured_flex_has_not_imported_yet(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(STUB_FLAG, raising=False)
    monkeypatch.setenv("IBKR_FLEX_TOKEN", "placeholder")
    monkeypatch.setenv("IBKR_FLEX_QUERY_ID", "placeholder")
    assert get(client, f"{PREFIX}/status").json()["holdings"]["state"] == "none"


def test_with_the_flag_off_a_long_term_row_has_all_null_fundamentals(
    client: TestClient, db_session: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_trading.db.models import User, Watchlist, WatchlistItem

    monkeypatch.delenv(STUB_FLAG, raising=False)
    user = User(email="owner@example.com", settings={})
    db_session.add(user)
    db_session.flush()
    lists = [Watchlist(user_id=user.id, name=n, horizon=h) for n, h in (("Long", "long_term"), ("Day", "intraday"))]
    db_session.add_all(lists)
    db_session.flush()
    db_session.add_all(
        WatchlistItem(watchlist_id=item.id, symbol="AAPL", asset_type="stock", position=0) for item in lists
    )
    db_session.commit()
    long_term, intraday = (get(client, f"{PREFIX}/watchlists/{item.id}/table").json()["rows"][0] for item in lists)
    assert set(long_term["fundamentals"]) == set(fundamental_schemas.Fundamentals.model_fields)
    assert all(value is None for value in long_term["fundamentals"].values())
    assert "fundamentals" not in intraday


def _walk(value: Any) -> Any:
    """Every (key, value) pair and every bare string of a JSON document."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _stamps(document: Any) -> list[dict[str, Any]]:
    return [
        value
        for _, value in _walk(document)
        if isinstance(value, dict) and {"as_of", "source", "quality", "freshness"} <= set(value)
    ]


def _fixture_documents() -> dict[str, Any]:
    return {path.stem: json.loads(path.read_text()) for path in sorted(FIXTURES.glob("*.json"))}


def test_every_stub_stamp_says_simulated_or_unavailable() -> None:
    """No invented number passes for a provider's: `source` is `simulated`, or null with nothing behind it."""
    seen = set()
    for name, document in _fixture_documents().items():
        if name == "watchlist_long_term_table":
            continue  # the real table route: its own stamps are the real feed's, only its `fundamentals` are invented
        for stamp in _stamps(document):
            seen.add(stamp["source"])
            if stamp["source"] is None:
                assert stamp["quality"] == "unavailable" and stamp["freshness"] == "unavailable", name
                assert stamp["as_of"] is None, name
            else:
                assert stamp["source"] == "simulated", name
                assert stamp["quality"] in {"delayed-15m", "eod"}, name
    assert seen == {"simulated", None}  # both labels are exercised


def test_no_fixture_or_stub_source_holds_an_account_number_or_an_email() -> None:
    files = [*FIXTURES.glob("*.json"), *STUB_SOURCE.glob("*.py")]
    assert files
    for path in files:
        text = path.read_text()
        assert not _ACCOUNT_NUMBER.search(text), path.name
        assert not _EMAIL.search(text), path.name


def test_no_response_field_or_value_can_carry_an_account_number_or_an_email() -> None:
    for name, document in _fixture_documents().items():
        for key, value in _walk(document):
            assert key.lower() not in _FORBIDDEN_KEYS, (name, key)
            if isinstance(value, str):
                assert not _ACCOUNT_NUMBER.search(value) and not _EMAIL.search(value), (name, key)


def test_no_fundamental_schema_declares_an_account_identifier_field() -> None:
    """02n §c1: an account is `{id, label, type}`. The scan is over every model of the Fundamental module and
    every schema FastAPI generated for it, so a future field cannot leak the external id by accident."""
    models = [
        value
        for value in vars(fundamental_schemas).values()
        if inspect.isclass(value) and issubclass(value, BaseModel) and value.__module__ == fundamental_schemas.__name__
    ]
    assert models
    for model in models:
        assert not _FORBIDDEN_KEYS & {name.lower() for name in model.model_fields}, model.__name__
    schemas = app.openapi()["components"]["schemas"]
    for model in models:
        properties = schemas[model.__name__].get("properties", {})
        assert not _FORBIDDEN_KEYS & {name.lower() for name in properties}, model.__name__
    assert set(schemas["AccountOut"]["properties"]) == {"id", "label", "type"}


def test_the_account_list_is_alias_and_type_only(stubbed: TestClient) -> None:
    body = get(stubbed, f"{PREFIX}/holdings").json()
    assert body["accounts"] == [
        {"id": 1, "label": "Taxable", "type": "taxable"},
        {"id": 2, "label": "IRA", "type": "ira"},
    ]


def test_holdings_agree_with_lots_coverage_and_short_calls(stubbed: TestClient) -> None:
    holdings = get(stubbed, f"{PREFIX}/holdings").json()
    coverage = get(stubbed, f"{PREFIX}/covered-calls/coverage").json()
    short_calls = get(stubbed, f"{PREFIX}/covered-calls/short-calls").json()
    assert holdings["import"]["lots"] == len(w.STOCK_LOTS) + len(holdings["option_lots"])
    assert round(sum(row["weight_pct"] for row in holdings["rows"])) == 100
    for row in holdings["rows"]:
        symbol = row["symbol"]
        lots = get(stubbed, f"{PREFIX}/holdings/{symbol}/lots").json()
        assert sum(lot["shares"] for lot in lots["lots"]) == row["shares"]
        assert sum(r["coverable"] for r in coverage["rows"] if r["symbol"] == symbol) == row["coverable_contracts"]
        assert sum(c["contracts"] for c in short_calls if c["symbol"] == symbol) == row["open_calls"]
        assert row["fundamentals"]["cc_coverable"] == row["coverable_contracts"]
        assert row["fundamentals"]["weight_pct"] == row["weight_pct"]
    assert {lot["id"] for lot in holdings["option_lots"]} == {call["id"] for call in short_calls}
    assert all(lot["contracts"] < 0 for lot in holdings["option_lots"])  # short


def test_an_account_filter_keeps_only_that_accounts_holdings(stubbed: TestClient) -> None:
    rows = get(stubbed, f"{PREFIX}/holdings?account_id=1").json()["rows"]
    assert {row["symbol"] for row in rows} == {"AAPL", "MSFT", "NVDA"}
    assert get(stubbed, f"{PREFIX}/holdings?account_id=99").status_code == 404


def test_coverage_is_the_engines_and_names_every_reason(stubbed: TestClient) -> None:
    body = get(stubbed, f"{PREFIX}/covered-calls/coverage").json()
    assert body["cap_pct"] == 50
    for row in body["rows"]:
        capped = engine.coverable_contracts(row["shares"], body["cap_pct"], 0)
        assert row["coverable"] == engine.coverable_contracts(row["shares"], body["cap_pct"], row["open_contracts"])
        assert (row["reason"] == "under_one_contract") == (capped == 0)
        assert row["reason_text"]
    assert {row["reason"] for row in body["rows"]} == {
        "ok",
        "under_one_contract",
        "earnings_wait",
        "fully_covered",
        "no_chain",
    }


def test_candidates_are_the_engines_top_three_best_first(stubbed: TestClient) -> None:
    for account_id in (1, 2):
        body = get(stubbed, f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id={account_id}").json()
        scores = [c["score"] for c in body["candidates"]]
        assert 0 < len(scores) <= 3 and scores == sorted(scores, reverse=True)
        for c in body["candidates"]:
            assert c["annualized_yield"] == pytest.approx(c["premium_yield"] * 365 / c["dte"], abs=1e-5)
            assert 0.15 <= c["delta"] <= 0.30 and c["open_interest"] >= 100 and c["spread_pct"] <= 10
        top = body["candidates"][0]
        assert body["opportunity"] == (top["annualized_yield"] >= 0.15 and body["iv_rank"] >= 50 and not top["flags"])
    taxable = get(stubbed, f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id=1").json()
    ira = get(stubbed, f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id=2").json()
    assert (taxable["opportunity"], ira["opportunity"]) == (False, True)
    assert "cover_tax_advantaged_first" in taxable["candidates"][0]["flags"]


def test_candidates_are_empty_with_an_unavailable_chain_when_there_is_nothing_to_show(stubbed: TestClient) -> None:
    """KO waits for earnings (an empty list, the chain itself is fine); MSFT has no chain stamp at all."""
    ko = get(stubbed, f"{PREFIX}/covered-calls/candidates?symbol=KO").json()
    assert ko["candidates"] == [] and ko["chain_stamp"]["source"] == "simulated"
    msft = get(stubbed, f"{PREFIX}/covered-calls/candidates?symbol=MSFT").json()
    assert msft["candidates"] == [] and msft["chain_stamp"]["freshness"] == "unavailable"
    assert msft["iv_rank"] is None and msft["iv_history_sessions"] < 60  # the engine hides a short history


def test_short_call_risks_are_the_engines_and_a_missing_delta_never_fires_a_rule(stubbed: TestClient) -> None:
    calls = {call["id"]: call for call in get(stubbed, f"{PREFIX}/covered-calls/short-calls").json()}
    assert [risk["kind"] for risk in calls[9]["risks"]] == [
        "delta_above_0_50",
        "near_strike_near_expiry",
        "earnings_before_expiry",
    ]
    assert calls[10]["delta"] is None and calls[10]["risks"] == []
    assert calls[8]["risks"] == [] and calls[8]["moneyness_pct"] < 0  # out of the money
    assert all(risk["text"] for call in calls.values() for risk in call["risks"])


def test_the_roll_panel_follows_the_account_type_and_the_quote(stubbed: TestClient) -> None:
    ko = get(stubbed, f"{PREFIX}/covered-calls/short-calls/9/roll").json()
    assert ko["assignment_note"]["account_type"] == "ira" and "Not tax advice" in ko["assignment_note"]["text"]
    assert ko["cost_to_close"] == 0.95 and all(c["net_credit"] >= 0.05 for c in ko["candidates"])
    taxable = get(stubbed, f"{PREFIX}/covered-calls/short-calls/8/roll").json()
    assert taxable["assignment_note"]["account_type"] == "taxable"
    jnj = get(stubbed, f"{PREFIX}/covered-calls/short-calls/10/roll").json()
    assert jnj["cost_to_close"] is None and jnj["candidates"] == [] and jnj["chain_stamp"]["freshness"] == "unavailable"


def test_income_months_trim_to_the_latest(stubbed: TestClient) -> None:
    full = get(stubbed, f"{PREFIX}/covered-calls/income").json()
    assert len(full["by_month"]) == 12 and full["state"] == "ok"
    assert full["ytd_premium"] == sum(m["premium"] for m in full["by_month"] if m["month"].startswith("2026"))
    last3 = get(stubbed, f"{PREFIX}/covered-calls/income?months=3").json()
    assert [m["month"] for m in last3["by_month"]] == ["2026-08", "2026-09", "2026-10"]
    assert get(stubbed, f"{PREFIX}/covered-calls/income?months=0").status_code == 422


def test_futures_rows_have_the_engines_dates_and_label_a_missing_price(stubbed: TestClient) -> None:
    body = get(stubbed, f"{PREFIX}/futures/readings").json()
    assert [row["root"] for row in body["rows"]] == ["/ES", "/NQ", "/CL", "/GC"]
    es, _, cl, gc = body["rows"]
    assert es["last"] is not None and es["stamp"]["source"] == "simulated"
    for row in (cl, gc):
        assert row["last"] is None and row["week_high"] is None and row["stamp"]["freshness"] == "unavailable"
        assert row["next_roll"] < row["expiry"]  # the dates are real even where the price is not
    assert body["macro_week"] and all(item["series_id"] for item in body["macro_week"])


def test_the_dashboard_strip_leaves_futures_unavailable(stubbed: TestClient) -> None:
    body = get(stubbed, f"{PREFIX}/dashboard/fundamental").json()
    strip = {tile["symbol"]: tile for tile in body["market_strip"]}
    assert list(strip) == ["SPY", "QQQ", "IWM", "/ES", "/NQ"]
    assert strip["/ES"]["last"] is None and strip["/ES"]["stamp"]["freshness"] == "unavailable"
    assert len(body["feed"]) <= 20
    assert [item["at"] for item in body["feed"]] == sorted((item["at"] for item in body["feed"]), reverse=True)


def test_the_brief_the_verdict_and_the_timeline_agree(stubbed: TestClient) -> None:
    brief = get(stubbed, f"{PREFIX}/research/brief").json()
    assert brief["run"]["analyzed"] == len(brief["rows"]) and brief["track_record"]["settled"] == 0
    for row in brief["rows"]:
        verdict = get(stubbed, f"{PREFIX}/research/symbols/{row['symbol']}").json()["verdict"]
        assert verdict["rating"] == row["rating"] and verdict["target"] == row["target"]
        assert verdict["target"]["low"] <= verdict["target"]["base"] <= verdict["target"]["high"]
    assert get(stubbed, f"{PREFIX}/research/symbols/JNJ").json()["verdict"] is None  # not analyzed yet
    kinds = {item["kind"] for item in get(stubbed, f"{PREFIX}/research/symbols/AAPL/timeline").json()["items"]}
    assert {"earnings", "desk_ai", "news", "strategy", "filing", "macro", "consensus"} == kinds


def test_valuation_blends_sixty_forty_and_hides_a_thin_reaction_history(stubbed: TestClient) -> None:
    body = get(stubbed, f"{PREFIX}/research/symbols/AAPL/valuation").json()
    values = {method["id"]: method["value"] for method in body["methods"]}
    others = (values["owner_earnings"] + values["ev_ebitda"] + values["residual_income"]) / 3
    assert body["blend"] == pytest.approx(0.6 * values["dcf"] + 0.4 * others, abs=0.01)
    reaction = body["earnings_reaction"]
    assert reaction["reports"] == len(reaction["series"]) and reaction["implied_move_pct"] is not None
    assert reaction["beats"]["n"] + reaction["misses"]["n"] == reaction["reports"]
    assert get(stubbed, f"{PREFIX}/research/symbols/NVDA/valuation").json()["earnings_reaction"] is None  # under 4


def test_timeline_filters_and_pages(stubbed: TestClient) -> None:
    everything = get(stubbed, f"{PREFIX}/research/symbols/KO/timeline").json()
    stamps = [item["at"] for item in everything["items"]]
    assert stamps == sorted(stamps, reverse=True) and everything["total"] == len(everything["items"])
    page = get(stubbed, f"{PREFIX}/research/symbols/KO/timeline?limit=2&offset=1").json()
    assert page["items"] == everything["items"][1:3] and page["total"] == everything["total"]
    news = get(stubbed, f"{PREFIX}/research/symbols/KO/timeline?kind=news").json()
    assert {item["kind"] for item in news["items"]} == {"news"} and news["total"] == 1
    assert get(stubbed, f"{PREFIX}/research/symbols/KO/timeline?kind=gossip").status_code == 422
    assert get(stubbed, f"{PREFIX}/research/symbols/KO/timeline?limit=0").status_code == 422


def test_the_three_alert_templates_list_with_their_rules(stubbed: TestClient) -> None:
    alerts = get(stubbed, f"{PREFIX}/fundamental-alerts").json()
    assert [a["template"] for a in alerts] == ["covered_call_income", "short_call_risk", "ai_daily_view"]
    ai = alerts[2]
    assert set(ai["rules"]) == {
        "rating_change",
        "cross_target",
        "eps_revision_pct",
        "earnings_within_days",
        "confidence_below",
    }
    assert ai["rules"]["eps_revision_pct"] == 3 and ai["rules"]["confidence_below"] == 50


def test_a_put_edits_the_rules_it_names_and_stores_nothing(stubbed: TestClient) -> None:
    put = stubbed.put(
        f"{PREFIX}/fundamental-alerts/ai_daily_view",
        json={"enabled": True, "scope": {"watchlist_id": 3}, "rules": {"confidence_below": 40}},
        headers=auth_headers(),
    )
    assert put.status_code == 200
    body = put.json()
    assert body["enabled"] is True and body["scope"] == {"watchlist_id": 3}
    assert body["rules"]["confidence_below"] == 40 and body["rules"]["eps_revision_pct"] == 3
    assert get(stubbed, f"{PREFIX}/fundamental-alerts").json()[2]["enabled"] is False  # the stub kept nothing


@pytest.mark.parametrize(
    ("url", "body"),
    [
        (f"{PREFIX}/fundamental-alerts/ai_daily_view", {"rules": {"colour": 1}}),
        (f"{PREFIX}/fundamental-alerts/ai_daily_view", {"rules": {"confidence_below": True}}),
        (f"{PREFIX}/fundamental-alerts/short_call_risk", {"rules": {"delta_above": False}}),
        (f"{PREFIX}/fundamental-alerts/short_call_risk", {"rules": {"delta_above": "high"}}),
        (f"{PREFIX}/fundamental-alerts/gossip", {"enabled": True}),
        (f"{PREFIX}/fundamental-alerts/ai_daily_view", {"surprise": 1}),
    ],
)
def test_a_bad_alert_edit_is_a_422(stubbed: TestClient, url: str, body: dict[str, Any]) -> None:
    assert stubbed.put(url, json=body, headers=auth_headers()).status_code == 422


def test_an_account_patch_changes_what_it_names(stubbed: TestClient) -> None:
    patched = stubbed.patch(f"{PREFIX}/accounts/2", json={"label": "Roth"}, headers=auth_headers())
    assert patched.json() == {"id": 2, "label": "Roth", "type": "ira"}
    typed = stubbed.patch(f"{PREFIX}/accounts/1", json={"type": "roth"}, headers=auth_headers())
    assert typed.json() == {"id": 1, "label": "Taxable", "type": "roth"}
    assert stubbed.patch(f"{PREFIX}/accounts/99", json={"label": "X"}, headers=auth_headers()).status_code == 404
    for body in ({}, {"type": "margin"}, {"label": ""}, {"label": "x" * 41}, {"external_id": "x"}):
        assert stubbed.patch(f"{PREFIX}/accounts/1", json=body, headers=auth_headers()).status_code == 422, body
    empty = stubbed.patch(f"{PREFIX}/accounts/1", json={}, headers=auth_headers()).json()
    assert empty["detail"]["problems"][0]["message"]  # the plain problems body of 02m §a1


def test_an_import_answers_202_with_the_running_state(stubbed: TestClient) -> None:
    response = stubbed.post(f"{PREFIX}/holdings/import", headers=auth_headers())
    assert response.status_code == 202
    assert response.json()["import"]["state"] == "running"


@pytest.mark.parametrize(
    "url",
    [
        f"{PREFIX}/holdings/ZZZZ/lots",
        f"{PREFIX}/covered-calls/candidates?symbol=ZZZZ",
        f"{PREFIX}/covered-calls/candidates?symbol=AAPL&account_id=99",
        f"{PREFIX}/covered-calls/candidates?symbol=MSFT&account_id=2",  # account 2 does not hold it
        f"{PREFIX}/covered-calls/short-calls/99/roll",
        f"{PREFIX}/research/symbols/ZZZZ",
        f"{PREFIX}/research/symbols/ZZZZ/valuation",
        f"{PREFIX}/research/symbols/ZZZZ/timeline",
    ],
)
def test_an_unknown_symbol_account_or_call_is_a_404(stubbed: TestClient, url: str) -> None:
    assert get(stubbed, url).status_code == 404


def test_candidates_need_a_symbol(stubbed: TestClient) -> None:
    assert get(stubbed, f"{PREFIX}/covered-calls/candidates").status_code == 422
