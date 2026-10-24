"""`GET /watchlists/{id}/table` on the real path: the bias label the refresher stored beside the metrics, and the
pattern and armed tags built from today's signals and the live strategies on the list. Needs Postgres."""

from datetime import UTC, datetime, timedelta

import pytest
from conftest import OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.core.calendar import et
from ai_trading.db.models import Signal, Strategy, StrategyVersion, SymbolMetrics, User

DAY = datetime(2026, 10, 6, 15, 0, tzinfo=UTC)  # 11:00 ET
NOW = DAY


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.setattr("ai_trading.api.watchlists.datetime", _Frozen)


class _Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz or UTC)


def _watchlist(client, symbols=("AAA", "BBB"), name="Mine") -> int:
    response = client.post("/api/desk/watchlists", json={"name": name, "horizon": "intraday"}, headers=auth_headers())
    watchlist_id = response.json()["id"]
    for symbol in symbols:
        client.post(
            f"/api/desk/watchlists/{watchlist_id}/items",
            json={"symbol": symbol, "asset_type": "stock"},
            headers=auth_headers(),
        )
    return watchlist_id


def _user_id(db_session) -> int:
    return db_session.execute(select(User.id).where(User.email == OWNER_EMAIL)).scalar_one()


def _strategy(db_session, name: str, when: dict, *, stage="alert_only", paused=None, universe=None, expires=None):
    user_id = _user_id(db_session)
    alert = {"channels": ["inbox"]}
    if expires:
        alert["expiresOn"] = expires
    spec = {
        "schemaVersion": 1,
        "name": name,
        "watch": {"universe": universe or {"watchlist": "Mine"}, "session": "regular", "runOn": "bar_close_15m"},
        "when": when,
        "then": {"alert": alert},
    }
    row = Strategy(
        owner_user_id=user_id, name=name, stage=stage, lane="technical", paused_reason=paused, created_at=NOW
    )
    db_session.add(row)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=row.id, version=1, schema_version=1, spec=spec, created_by=user_id, created_at=NOW
    )
    db_session.add(version)
    db_session.flush()
    row.current_version_id = version.id
    db_session.commit()
    return row, version


def _signal(db_session, version, symbol: str, bar_time: datetime) -> None:
    db_session.add(
        Signal(
            strategy_version_id=version.id,
            symbol=symbol,
            bar_time=bar_time,
            evidence={},
            data_quality="delayed-15m",
            created_at=bar_time,
        )
    )
    db_session.commit()


PATTERN = {"op": "pattern", "pattern": "hammer"}
PLAIN = {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}}


def _rows(client, watchlist_id: int) -> dict:
    body = client.get(f"/api/desk/watchlists/{watchlist_id}/table", headers=auth_headers()).json()
    return {row["symbol"]: row for row in body["rows"]}


def test_bias_label_is_the_stored_15_minute_summary_or_warming_up(client, db_session):
    watchlist_id = _watchlist(client)
    db_session.add(
        SymbolMetrics(
            symbol="AAA", as_of=NOW, source="alpaca", quality="delayed-15m", metrics={"last": 10.0, "bias_15m": "Buy"}
        )
    )
    db_session.commit()
    rows = _rows(client, watchlist_id)
    assert rows["AAA"]["bias_label"] == "Buy" and rows["AAA"]["last"] == 10.0
    assert rows["BBB"]["bias_label"] == "warming up"


def test_a_pattern_signal_today_is_a_pattern_tag_and_the_strategy_is_not_armed_on_that_symbol(client, db_session):
    watchlist_id = _watchlist(client)
    _, hammer = _strategy(db_session, "Hammer 15m", PATTERN)
    _signal(db_session, hammer, "AAA", datetime(2026, 10, 6, 14, 15, tzinfo=UTC))
    _signal(db_session, hammer, "BBB", datetime(2026, 10, 5, 14, 15, tzinfo=UTC))  # yesterday: not a tag
    rows = _rows(client, watchlist_id)
    assert rows["AAA"]["tags"] == [{"kind": "pattern", "label": "Hammer 15m", "at": "2026-10-06T14:15:00Z"}]
    assert rows["BBB"]["tags"] == [{"kind": "armed", "label": "Hammer 15m armed", "at": None}]


def test_a_non_pattern_signal_makes_no_pattern_tag(client, db_session):
    watchlist_id = _watchlist(client)
    _, plain = _strategy(db_session, "Above one", PLAIN)
    _signal(db_session, plain, "AAA", datetime(2026, 10, 6, 14, 15, tzinfo=UTC))
    rows = _rows(client, watchlist_id)
    assert rows["AAA"]["tags"] == []  # fired today, so not armed either
    assert rows["BBB"]["tags"] == [{"kind": "armed", "label": "Above one armed", "at": None}]


def test_only_live_strategies_on_this_list_are_armed(client, db_session):
    watchlist_id = _watchlist(client, symbols=("AAA",))
    _strategy(db_session, "Draft", PLAIN, stage="draft")
    _strategy(db_session, "Paused", PLAIN, paused="user")
    _strategy(db_session, "Expired", PLAIN, expires="2026-10-05")
    _strategy(db_session, "Elsewhere", PLAIN, universe={"watchlist": "Other"})
    _strategy(db_session, "By symbol", PLAIN, universe={"symbols": ["AAA"]})
    assert _rows(client, watchlist_id)["AAA"]["tags"] == [{"kind": "armed", "label": "By symbol armed", "at": None}]


def test_pause_all_arms_nothing_and_a_row_shows_at_most_three_tags(client, db_session):
    watchlist_id = _watchlist(client, symbols=("AAA",))
    for index in range(5):
        _strategy(db_session, f"Strategy {index}", PLAIN)
    assert len(_rows(client, watchlist_id)["AAA"]["tags"]) == 3
    client.put("/api/desk/settings", json={"settings": {"pause_all": True}}, headers=auth_headers())
    assert _rows(client, watchlist_id)["AAA"]["tags"] == []


def test_the_start_of_the_new_york_day_is_the_cut_for_today(client, db_session):
    watchlist_id = _watchlist(client, symbols=("AAA",))
    _, hammer = _strategy(db_session, "Hammer 15m", PATTERN)
    just_before = et(DAY.date(), "00:00").to_pydatetime() - timedelta(seconds=1)
    _signal(db_session, hammer, "AAA", just_before)
    tags = _rows(client, watchlist_id)["AAA"]["tags"]
    assert [t["kind"] for t in tags] == ["armed"]  # a signal a second before midnight ET is yesterday's
