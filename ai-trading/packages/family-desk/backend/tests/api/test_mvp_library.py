"""02m §a3.6: the strategy library. The catalog is read from files; attach validates for real and stores
nothing in stub mode (the response is the copy's shape, and 503 with the stub flag off)."""

from conftest import OTHER_EMAIL, auth_headers

FUTURES_REASON = "Futures alerts start when IBKR quotes connect"
FILTER_REASON = "Copy this preset to My filters instead"
HAMMER_STUB_ID = 100 + 10  # hammer's position in catalog.json (the ten filters come first)


def _watchlist(client, name="Day movers") -> int:
    response = client.post("/api/desk/watchlists", json={"name": name, "horizon": "intraday"}, headers=auth_headers())
    assert response.status_code == 201
    return response.json()["id"]


def _attach(client, entry_id: str, **body):
    return client.post(f"/api/desk/library/{entry_id}/attach", json=body, headers=auth_headers())


def test_default_list_is_the_37_technical_strategies(client):
    items = client.get("/api/desk/library", headers=auth_headers()).json()

    assert len(items) == 37
    assert {item["kind"] for item in items} == {"strategy"}
    assert {item["lane"] for item in items} == {"technical"}
    assert {item["id"] for item in items if not item["attachable"]} == {"futures-overnight-range-break"}
    futures = next(item for item in items if item["id"] == "futures-overnight-range-break")
    assert futures["attach_blocked_reason"] == FUTURES_REASON
    hammer = next(item for item in items if item["id"] == "hammer")
    assert hammer == {
        "id": "hammer",
        "file": "patterns/hammer.json",
        "kind": "strategy",
        "lane": "technical",
        "category": "candlestick",
        "bias": "bullish",
        "label": "Hammer",
        "summary": hammer["summary"],
        "attachable": True,
        "attach_blocked_reason": None,
    }


def test_filter_kind_lists_the_ten_screener_presets_none_attachable(client):
    items = client.get("/api/desk/library?kind=filter", headers=auth_headers()).json()

    assert len(items) == 10
    assert all(item["attachable"] is False for item in items)
    assert {item["attach_blocked_reason"] for item in items} == {FILTER_REASON}


def test_category_and_search_filter_the_catalog(client):
    candlestick = client.get("/api/desk/library?category=candlestick", headers=auth_headers()).json()
    hammers = client.get("/api/desk/library?q=HAMMER", headers=auth_headers()).json()
    nothing = client.get("/api/desk/library?q=zzz-no-such-preset", headers=auth_headers()).json()

    assert len(candlestick) == 20
    assert [item["id"] for item in hammers] == ["hammer", "inverted-hammer"]
    assert nothing == []


def test_detail_carries_spec_defaults_and_no_example_outside_stub_mode(client, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)

    body = client.get("/api/desk/library/hammer", headers=auth_headers()).json()

    assert body["spec"]["name"] == "Hammer"
    assert body["spec"]["when"]["pattern"] == "hammer"
    assert body["defaults"] == {"limits": {}, "severity": "opportunity", "channels": ["inbox"]}
    assert body["example"] is None
    assert body["attachable"] is True


def test_detail_of_a_filter_has_empty_defaults_and_is_not_attachable(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")

    body = client.get("/api/desk/library/gap-up", headers=auth_headers()).json()

    assert body["kind"] == "filter"
    assert body["defaults"] == {}
    assert body["example"] is None
    assert body["attach_blocked_reason"] == FILTER_REASON


def test_detail_example_is_the_first_snapshot_occurrence_in_stub_mode(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")

    body = client.get("/api/desk/library/hammer", headers=auth_headers()).json()

    assert body["example"] == {
        "symbol": "MSFT",
        "timeframe": "15m",
        "bar_time": "2026-10-23T18:45:00Z",
        "ohlc": [523.805, 524.09, 523.27, 524.035],
    }


def test_unknown_entry_is_404(client):
    assert client.get("/api/desk/library/no-such-preset", headers=auth_headers()).status_code == 404
    assert _attach(client, "no-such-preset", watchlist_id=1).status_code == 404


def test_futures_entry_detail_is_not_attachable_with_the_reason(client):
    body = client.get("/api/desk/library/futures-overnight-range-break", headers=auth_headers()).json()

    assert body["attachable"] is False
    assert body["attach_blocked_reason"] == FUTURES_REASON


def test_attach_in_stub_mode_answers_the_copy_without_storing_it(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    watchlist_id = _watchlist(client)

    response = _attach(client, "hammer", watchlist_id=watchlist_id)

    assert response.status_code == 201
    body = response.json()
    assert body["id"] == HAMMER_STUB_ID
    assert body["name"] == "Hammer"
    assert body["origin"] == "library"
    assert (body["stage"], body["status"]) == ("draft", "draft")  # the alerts runtime flag is off
    assert body["source"] == {"kind": "watchlist", "id": watchlist_id, "label": "Day movers"}
    assert body["category"] == "pattern"
    assert body["run_on"] == "bar_close_15m"
    assert body["frequency"] == "once_per_bar"
    assert body["channels"] == ["inbox"]
    assert body["severity"] == "opportunity"
    assert (body["version"], body["paused_reason"], body["last_fired_at"], body["fires_7d"]) == (1, None, None, 0)
    assert body["spec"]["watch"]["universe"] == {"watchlist": "Day movers"}
    assert "paperOrder" not in body["spec"]["then"]
    assert client.get("/api/desk/watchlists", headers=auth_headers()).status_code == 200


def test_attach_reports_alert_only_when_the_runtime_flag_is_on(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    watchlist_id = _watchlist(client)

    body = _attach(client, "hammer", watchlist_id=watchlist_id).json()

    assert (body["stage"], body["status"]) == ("alert_only", "active")


def test_attach_is_503_with_the_stub_flag_off_once_the_request_is_valid(client, monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    watchlist_id = _watchlist(client)

    assert _attach(client, "hammer", watchlist_id=watchlist_id).status_code == 503


def test_attach_refuses_filters_and_futures_with_422(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    watchlist_id = _watchlist(client)

    filter_response = _attach(client, "gap-up", watchlist_id=watchlist_id)
    futures_response = _attach(client, "futures-overnight-range-break", watchlist_id=watchlist_id)

    assert filter_response.status_code == 422
    assert filter_response.json() == {"detail": FILTER_REASON}
    assert futures_response.status_code == 422
    assert futures_response.json() == {"detail": FUTURES_REASON}


def test_attach_channels_are_validated_into_the_problems_shape(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    watchlist_id = _watchlist(client)

    not_inbox_first = _attach(client, "hammer", watchlist_id=watchlist_id, channels=["telegram"])
    repeated = _attach(client, "hammer", watchlist_id=watchlist_id, channels=["inbox", "inbox"])
    bad_severity = _attach(client, "hammer", watchlist_id=watchlist_id, severity="panic")

    assert not_inbox_first.status_code == 422
    assert not_inbox_first.json() == {
        "detail": {"problems": [{"path": "then.alert.channels", "message": "the first alert channel must be inbox"}]}
    }
    assert repeated.status_code == 422
    assert repeated.json()["detail"]["problems"][0]["message"] == "alert channels must not repeat"
    assert bad_severity.status_code == 422
    assert bad_severity.json()["detail"]["problems"][0]["path"] == "then.alert.severity"


def test_attach_needs_a_watchlist_she_owns(client, monkeypatch):
    monkeypatch.setenv("DESK_MVP_STUB", "1")
    other_watchlist = client.post(
        "/api/desk/watchlists",
        json={"name": "Theirs", "horizon": "swing"},
        headers=auth_headers(OTHER_EMAIL),
    ).json()["id"]

    assert _attach(client, "hammer", watchlist_id=other_watchlist).status_code == 404
    assert _attach(client, "hammer", watchlist_id=999999).status_code == 404
