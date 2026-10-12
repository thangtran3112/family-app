from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

VALID_SPEC = {
    "schemaVersion": 1,
    "name": "Close above 100",
    "watch": {"universe": {"symbols": ["AAPL"]}, "session": "regular", "runOn": "daily_close"},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}},
    "then": {"alert": {"channels": ["inbox"]}},
}

# vwap is intraday-only (ai_trading.core.evaluate.check); daily_close uses daily bars, so this
# spec is schema-valid but fails `check()` -- Review Focus-adjacent but for strategies, not ticks.
CHECK_VIOLATION_SPEC = {
    **VALID_SPEC,
    "when": {"op": "gt", "left": {"series": "vwap"}, "right": {"value": 100.0}},
}


def _create_strategy(client, email: str = OWNER_EMAIL) -> int:
    response = client.post("/api/desk/strategies", json={"name": "My strategy"}, headers=auth_headers(email))
    assert response.status_code == 201
    return response.json()["id"]


def test_create_strategy_starts_in_draft_stage_with_no_current_version(client):
    strategy_id = _create_strategy(client)
    row = client.get("/api/desk/strategies", headers=auth_headers()).json()[0]
    assert row["id"] == strategy_id
    assert row["stage"] == "draft"
    assert row["current_version_id"] is None


def test_create_version_rejects_a_schema_invalid_spec_with_400(client):
    strategy_id = _create_strategy(client)
    bad_spec = {**VALID_SPEC, "schemaVersion": 2}  # only 1 is a valid Literal

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": bad_spec}, headers=auth_headers()
    )

    assert response.status_code == 400


def test_create_version_rejects_a_check_violation_with_400(client):
    strategy_id = _create_strategy(client)

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": CHECK_VIOLATION_SPEC}, headers=auth_headers()
    )

    assert response.status_code == 400
    assert "vwap" in response.json()["detail"]


def test_create_version_sets_it_as_the_strategys_current_version(client):
    strategy_id = _create_strategy(client)

    version = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": VALID_SPEC}, headers=auth_headers()
    ).json()

    strategy = client.get("/api/desk/strategies", headers=auth_headers()).json()[0]
    assert version["version"] == 1
    assert strategy["current_version_id"] == version["id"]


def test_versions_are_404_for_a_strategy_owned_by_someone_else(client):
    strategy_id = _create_strategy(client, OWNER_EMAIL)

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": VALID_SPEC}, headers=auth_headers(OTHER_EMAIL)
    )

    assert response.status_code == 404


def test_stage_transition_rejects_skip_ahead_and_an_unknown_stage(client):
    strategy_id = _create_strategy(client)

    skip_ahead = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper", "confirm": True}, headers=auth_headers()
    )
    unknown = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "live_confirm"}, headers=auth_headers()
    )

    assert skip_ahead.status_code == 400  # draft -> paper is not draft -> alert_only
    assert unknown.status_code == 400  # live_confirm/live_auto do not exist in this schema (§2)


def test_stage_transition_to_paper_requires_confirm_true(client):
    strategy_id = _create_strategy(client)
    client.put(f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "alert_only"}, headers=auth_headers())

    without_confirm = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper"}, headers=auth_headers()
    )
    with_confirm = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper", "confirm": True}, headers=auth_headers()
    )

    assert without_confirm.status_code == 400
    assert with_confirm.status_code == 200
    assert with_confirm.json()["stage"] == "paper"
