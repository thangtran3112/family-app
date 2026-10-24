"""`/api/desk/library/{id}/attach` and the real `example` on the stored path (stub flag off). Needs Postgres."""

import json
from datetime import UTC, datetime

import pytest
from bars import daily_bars, trading_days
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import func, select

from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Strategy, StrategyVersion, User, Watchlist, WatchlistItem
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.library.example import find_example

NOW = datetime(2026, 10, 6, 22, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.delenv("DESK_ALERTS_RUNTIME_ENABLED", raising=False)


def _watchlist(client, name="Day movers") -> int:
    response = client.post("/api/desk/watchlists", json={"name": name, "horizon": "intraday"}, headers=auth_headers())
    assert response.status_code == 201
    return response.json()["id"]


def _attach(client, entry_id: str, email: str = OWNER_EMAIL, **body):
    return client.post(f"/api/desk/library/{entry_id}/attach", json=body, headers=auth_headers(email))


def _user_id(db_session, email: str = OWNER_EMAIL) -> int:
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def test_attach_writes_a_draft_alert_only_copy_on_the_watchlist(client, db_session):
    watchlist_id = _watchlist(client)
    response = _attach(client, "hammer", watchlist_id=watchlist_id, channels=["inbox", "telegram"], severity="risk")
    assert response.status_code == 201
    body = response.json()
    assert (body["name"], body["origin"], body["stage"], body["status"], body["version"]) == (
        "Hammer",
        "library",
        "draft",
        "draft",
        1,
    )
    assert body["source"] == {"kind": "watchlist", "id": watchlist_id, "label": "Day movers"}
    assert (body["channels"], body["severity"], body["category"]) == (["inbox", "telegram"], "risk", "pattern")
    assert "paperOrder" not in json.dumps(body["spec"])
    assert body["spec"]["watch"]["universe"] == {"watchlist": "Day movers"}
    row = db_session.get(Strategy, body["id"])
    assert (row.lane, row.origin, row.stage) == ("technical", "library", "draft")
    assert row.owner_user_id == _user_id(db_session)


def test_attach_is_idempotent_per_preset_and_watchlist(client, db_session):
    first_list = _watchlist(client)
    second_list = _watchlist(client, "Swing")
    first = _attach(client, "hammer", watchlist_id=first_list)
    again = _attach(client, "hammer", watchlist_id=first_list, severity="risk")  # different options, same strategy
    other_list = _attach(client, "hammer", watchlist_id=second_list)
    other_preset = _attach(client, "doji", watchlist_id=first_list)
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"] and again.json()["severity"] == "opportunity"
    assert other_list.status_code == 201 and other_list.json()["id"] != first.json()["id"]
    assert other_preset.status_code == 201
    assert db_session.scalar(select(func.count()).select_from(Strategy)) == 3
    assert db_session.scalar(select(func.count()).select_from(StrategyVersion)) == 3


def test_attach_starts_alert_only_with_the_runtime_flag_on(client, monkeypatch):
    monkeypatch.setenv("DESK_ALERTS_RUNTIME_ENABLED", "1")
    body = _attach(client, "hammer", watchlist_id=_watchlist(client)).json()
    assert (body["stage"], body["status"]) == ("alert_only", "active")


def test_an_attach_that_was_archived_is_attached_again(client):
    watchlist_id = _watchlist(client)
    first = _attach(client, "hammer", watchlist_id=watchlist_id).json()
    client.delete(f"/api/desk/alert-strategies/{first['id']}", headers=auth_headers())
    second = _attach(client, "hammer", watchlist_id=watchlist_id)
    assert second.status_code == 201 and second.json()["id"] != first["id"]


def test_attach_refuses_filters_futures_and_unknown_things(client):
    watchlist_id = _watchlist(client)
    assert _attach(client, "gap-up", watchlist_id=watchlist_id).status_code == 422
    assert _attach(client, "futures-overnight-range-break", watchlist_id=watchlist_id).status_code == 422
    assert _attach(client, "no-such-preset", watchlist_id=watchlist_id).status_code == 404
    assert _attach(client, "hammer", watchlist_id=99999).status_code == 404
    assert _attach(client, "hammer", watchlist_id=watchlist_id, channels=["telegram"]).status_code == 422  # inbox first


def test_another_users_watchlist_is_a_404(client, db_session):
    watchlist_id = _watchlist(client)
    client.get("/api/desk/settings", headers=auth_headers(OTHER_EMAIL))
    assert _attach(client, "hammer", OTHER_EMAIL, watchlist_id=watchlist_id).status_code == 404
    assert db_session.scalar(select(func.count()).select_from(Strategy)) == 0


def test_every_attachable_preset_attaches_and_its_stored_spec_never_orders(client, db_session):
    watchlist_id = _watchlist(client)
    attachable = [e for e in load_catalog().entries if e.kind == "strategy" and e.category != "futures"]
    assert len(attachable) == 36
    for entry in attachable:
        response = _attach(client, entry.id, watchlist_id=watchlist_id)
        assert response.status_code == 201, (entry.id, response.text)
        assert "paperOrder" not in json.dumps(response.json()["spec"]), entry.id
    assert db_session.scalar(select(func.count()).select_from(Strategy)) == 36
    again = [_attach(client, e.id, watchlist_id=watchlist_id).status_code for e in attachable]
    assert set(again) == {200}
    assert db_session.scalar(select(func.count()).select_from(Strategy)) == 36


# -- the real example --------------------------------------------------------------------------------------


def _add_watchlist(db_session, user_id: int, symbols: tuple[str, ...]) -> None:
    watchlist = Watchlist(user_id=user_id, name="Mine", horizon="swing")
    db_session.add(watchlist)
    db_session.flush()
    for position, symbol in enumerate(symbols):
        db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol=symbol, asset_type="stock", position=position))
    db_session.commit()


def _above_100() -> dict:
    return {
        "schemaVersion": 1,
        "name": "Close above 100",
        "watch": {"universe": {"watchlist": "Mine"}, "session": "regular", "runOn": "daily_close"},
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100}},
        "then": {"alert": {"channels": ["inbox"]}},
    }


def test_the_example_is_the_newest_firing_on_her_stored_bars(client, db_session):
    client.get("/api/desk/settings", headers=auth_headers())
    user_id = _user_id(db_session)
    _add_watchlist(db_session, user_id, ("AAA", "BBB"))
    days = trading_days("stock", datetime(2026, 10, 6).date(), 6)
    for symbol, closes in (("AAA", [99, 99, 101, 99, 99, 99]), ("BBB", [99, 99, 99, 99, 105, 99])):
        frame = daily_bars(days, [float(c) for c in closes])
        frame["high"] = frame["close"] + 1.0
        frame["low"] = frame["close"] - 1.0
        upsert_bars(db_session, symbol, "1d", frame, "alpaca", "stock", now=NOW)
    db_session.commit()

    example = find_example(db_session, user_id, _above_100(), now=NOW)
    assert example is not None
    assert (example["symbol"], example["timeframe"]) == ("BBB", "1d")  # BBB fired on a later day than AAA
    assert example["ohlc"] == [105.0, 106.0, 104.0, 105.0]
    assert example["bar_time"] == datetime(2026, 10, 5, 20, 0, tzinfo=UTC)


def test_the_example_is_none_without_a_firing_without_bars_or_when_the_engine_cannot_run_the_template(
    client, db_session
):
    client.get("/api/desk/settings", headers=auth_headers())
    user_id = _user_id(db_session)
    assert find_example(db_session, user_id, _above_100(), now=NOW) is None  # no watchlists at all
    _add_watchlist(db_session, user_id, ("AAA",))
    assert find_example(db_session, user_id, _above_100(), now=NOW) is None  # a watchlist but no bars
    days = trading_days("stock", datetime(2026, 10, 6).date(), 3)
    upsert_bars(db_session, "AAA", "1d", daily_bars(days, [90.0, 91.0, 92.0]), "alpaca", "stock", now=NOW)
    db_session.commit()
    assert find_example(db_session, user_id, _above_100(), now=NOW) is None  # bars but nothing fired
    vwap_daily = {**_above_100(), "when": {"op": "gt", "left": {"series": "close"}, "right": {"series": "vwap"}}}
    assert find_example(db_session, user_id, vwap_daily, now=NOW) is None  # the engine gate rejects it
    assert find_example(db_session, user_id, {"name": "not a spec"}, now=NOW) is None


def test_the_detail_endpoint_carries_the_real_example_for_a_strategy_and_none_for_a_filter(client, db_session):
    client.get("/api/desk/settings", headers=auth_headers())
    user_id = _user_id(db_session)
    _add_watchlist(db_session, user_id, ("AAA",))
    hammer = client.get("/api/desk/library/hammer", headers=auth_headers()).json()
    assert hammer["example"] is None  # nothing stored
    assert hammer["spec"] == load_template("patterns/hammer.json")
    gap_up = client.get("/api/desk/library/gap-up", headers=auth_headers()).json()
    assert gap_up["example"] is None and gap_up["defaults"] == {}
