"""`/api/desk/screener*` in stub mode (02m §a3.4): response shapes and the 409/404/422 rules. The real path is
`test_screener_real.py`."""

import pytest
from conftest import auth_headers

from ai_trading.library.catalog import load_template

ABNORMAL_VOLUME = load_template("filters/abnormal-volume.json")
BASE = "/api/desk/screener"


@pytest.fixture
def stub_on(monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")


def _get(client, path):
    return client.get(f"{BASE}{path}", headers=auth_headers())


def test_list_returns_the_ten_seeds_in_catalog_order_with_their_last_run(client, stub_on):
    rows = _get(client, "/filters").json()
    assert [row["id"] for row in rows] == list(range(1, 11))
    assert rows[0] == {
        "id": 1,
        "name": "Abnormal volume",
        "origin": "seed",
        "seed_key": "abnormal-volume",
        "read_only": True,
        "run_on": "bar_close_15m",
        "session": "regular",
        "last_run": {
            "evaluation_point": "2026-10-23T19:45:00Z",
            "matches_total": 9,
            "scanned": 131,
            "stamp": {
                "as_of": "2026-10-23T20:00:00Z",
                "source": "alpaca",
                "quality": "delayed-15m",
                "freshness": "closed",
            },
        },
    }
    # A daily filter's first match is at the 16:00 ET close, which is the snapshot's as_of.
    assert rows[5]["name"] == "52-week breakout"
    assert rows[5]["last_run"]["evaluation_point"] == "2026-10-23T20:00:00Z"


def test_detail_of_a_seed_is_read_only_with_no_default_to_reset_to(client, stub_on):
    body = _get(client, "/filters/1").json()
    assert (body["id"], body["name"], body["origin"], body["read_only"], body["version"]) == (
        1,
        "Abnormal volume",
        "seed",
        True,
        1,
    )
    assert body["spec"]["watch"]["runOn"] == "bar_close_15m"
    assert body["default_spec"] is None


def test_copying_a_seed_returns_an_editable_echo_as_id_11_and_persists_nothing(client, stub_on):
    seed_spec = _get(client, "/filters/1").json()["spec"]
    response = client.post(f"{BASE}/filters", json={"copy_of": 1}, headers=auth_headers())
    assert response.status_code == 201
    body = response.json()
    assert (body["id"], body["name"], body["origin"], body["read_only"], body["version"]) == (
        11,
        "Abnormal volume (copy)",
        "user",
        False,
        1,
    )
    assert body["default_spec"] == seed_spec
    assert body["spec"]["name"] == "Abnormal volume (copy)"
    assert _get(client, "/filters/11").status_code == 404
    assert client.post(f"{BASE}/filters", json={"copy_of": 99}, headers=auth_headers()).status_code == 404


def test_copy_or_spec_must_be_exactly_one_of_the_two(client, stub_on):
    neither = client.post(f"{BASE}/filters", json={}, headers=auth_headers())
    both = client.post(f"{BASE}/filters", json={"copy_of": 1, "spec": ABNORMAL_VOLUME}, headers=auth_headers())
    assert neither.status_code == 422
    assert both.status_code == 422


def test_an_invalid_spec_answers_422_with_a_dotted_path_and_a_plain_message(client, stub_on):
    bad = {**ABNORMAL_VOLUME, "watch": {**ABNORMAL_VOLUME["watch"], "runOn": "monthly"}}
    response = client.post(f"{BASE}/filters", json={"spec": bad}, headers=auth_headers())
    assert response.status_code == 422
    (problem,) = response.json()["detail"]["problems"]
    assert problem["path"] == "watch.runOn"
    assert problem["message"]


def test_a_valid_spec_is_echoed_as_a_new_filter(client, stub_on):
    response = client.post(f"{BASE}/filters", json={"spec": ABNORMAL_VOLUME}, headers=auth_headers())
    assert response.status_code == 201
    assert (response.json()["id"], response.json()["name"], response.json()["origin"]) == (
        11,
        "Abnormal volume",
        "user",
    )


def test_put_and_delete_on_a_seed_answer_409_and_an_unknown_id_404(client, stub_on):
    put_seed = client.put(f"{BASE}/filters/1", json={"spec": ABNORMAL_VOLUME}, headers=auth_headers())
    assert put_seed.status_code == 409
    assert put_seed.json()["detail"] == "Default filters can't be edited · copy it to edit"
    assert client.delete(f"{BASE}/filters/1", headers=auth_headers()).status_code == 409
    assert client.put(f"{BASE}/filters/99", json={"spec": ABNORMAL_VOLUME}, headers=auth_headers()).status_code == 404
    assert client.delete(f"{BASE}/filters/99", headers=auth_headers()).status_code == 404
    assert _get(client, "/filters/99").status_code == 404


def test_results_have_the_snapshot_matches_with_their_columns_and_table(client, stub_on):
    body = _get(client, "/filters/1/results?session=regular").json()
    assert (body["filter_id"], body["run_on"], body["session"]) == (1, "bar_close_15m", "regular")
    assert (body["matches_total"], body["matches_returned"], body["scanned"]) == (9, 8, 131)
    assert body["evaluation_point"] == "2026-10-23T19:45:00Z"
    assert [c["key"] for c in body["table_columns"]][:3] == ["last", "rvol_10d", "change_pct"]
    top = body["matches"][0]
    assert (top["symbol"], top["matched_since"], top["rank_value"]) == ("BOLT", "2026-10-23T18:00:00Z", 472.720678)
    assert top["operands"] == {"rvol(10)": 472.720678}
    assert top["columns"]["last"] == 6.27
    assert top["columns"]["rvol_10d"] == 461.779


def test_a_52_week_filter_shows_the_level_and_distance_columns(client, stub_on):
    keys = [c["key"] for c in _get(client, "/filters/6/results").json()["table_columns"]]
    assert keys[-3:] == ["high_252d", "dist_to_252d_high_pct", "matched_since"]


def test_results_reject_an_unknown_session_literal(client, stub_on):
    assert _get(client, "/filters/1/results?session=overnight").status_code == 422


def test_preview_of_a_saved_spec_gives_its_totals_and_top_five(client, stub_on):
    body = client.post(f"{BASE}/preview", json={"spec": ABNORMAL_VOLUME}, headers=auth_headers()).json()
    assert body["problems"] == []
    assert body["matches_total"] == 9
    assert body["scanned"] == 131
    assert [row["symbol"] for row in body["top"]] == ["BOLT", "LKQ", "SPTI", "RHI", "TNGX"]


def test_preview_of_an_invalid_spec_is_200_with_problems_and_no_totals(client, stub_on):
    bad = {**ABNORMAL_VOLUME, "watch": {**ABNORMAL_VOLUME["watch"], "runOn": "monthly"}}
    body = client.post(f"{BASE}/preview", json={"spec": bad}, headers=auth_headers()).json()
    assert body["problems"][0]["path"] == "watch.runOn"
    assert body["matches_total"] is None
    assert body["top"] == []


def test_universe_gives_the_scan_basis_and_counts(client, stub_on):
    body = _get(client, "/universe").json()
    assert (body["candidates"], body["scanned"], body["dropped_non_plain_tickers"], body["no_daily_data"]) == (
        245,
        131,
        4,
        5,
    )
    assert body["liquidity_floor"] == {"minPrice": 5, "minAvgVolume": 500000, "avgVolumeDays": 20}


def test_validation_is_real_with_the_flag_off(client):
    valid = client.post(f"{BASE}/preview", json={"spec": ABNORMAL_VOLUME}, headers=auth_headers()).json()
    assert valid == {"problems": [], "matches_total": 0, "scanned": 0, "top": []}  # an empty store: nothing to scan
    bad = {**ABNORMAL_VOLUME, "watch": {**ABNORMAL_VOLUME["watch"], "runOn": "monthly"}}
    invalid = client.post(f"{BASE}/preview", json={"spec": bad}, headers=auth_headers()).json()
    assert invalid["problems"][0]["path"] == "watch.runOn"
    create = client.post(f"{BASE}/filters", json={"spec": bad}, headers=auth_headers())
    assert create.status_code == 422
    assert create.json()["detail"]["problems"][0]["path"] == "watch.runOn"
