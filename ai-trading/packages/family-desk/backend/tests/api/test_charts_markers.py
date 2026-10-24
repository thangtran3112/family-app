"""`GET /charts/{symbol}/markers` on the real path (stub flag off): `core/patterns.py` on stored bars, checked
against the 02m snapshot's recorded occurrences (`tests/fixtures/patterns/`), plus the fires of her strategies.
Needs Postgres."""

from datetime import UTC, datetime

import pandas as pd
import pattern_fixture
import pytest
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.api.charts import _stored_bars
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Signal, Strategy, StrategyVersion, User
from ai_trading.library.catalog import load_catalog

PATH = "/api/desk/charts/{}/markers"
STORED = datetime(2026, 10, 23, 21, 0, tzinfo=UTC)  # after the extended-hours close: every bar has closed
DAY_START, DAY_END = "2026-10-23T13:30:00Z", "2026-10-23T20:00:00Z"
TEMPLATES = [e.id for e in load_catalog().entries if e.kind == "strategy" and e.file.startswith("patterns/")]


@pytest.fixture(autouse=True)
def real(monkeypatch):
    monkeypatch.delenv("DESK_MVP_STUB", raising=False)
    monkeypatch.setattr("ai_trading.api.charts.datetime", _Frozen)


class _Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return STORED.astimezone(tz or UTC)


def _store(db_session, symbol: str) -> None:
    upsert_bars(db_session, symbol, "1m", pattern_fixture.minutes(symbol), "alpaca", "stock", now=STORED)
    upsert_bars(db_session, symbol, "1d", pattern_fixture.daily(symbol), "alpaca", "stock", now=STORED)
    db_session.commit()


def _user_id(client, db_session, email: str = OWNER_EMAIL) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _strategy(db_session, user_id: int, name: str, when: dict, *, archived: bool = False) -> tuple[Strategy, int]:
    spec = {
        "schemaVersion": 1,
        "name": name,
        "watch": {"universe": {"symbols": ["PLTR"]}, "session": "regular", "runOn": "bar_close_15m"},
        "when": when,
        "then": {"alert": {"channels": ["inbox"]}},
    }
    row = Strategy(
        owner_user_id=user_id,
        name=name,
        stage="alert_only",
        lane="technical",
        created_at=STORED,
        archived_at=STORED if archived else None,
    )
    db_session.add(row)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=row.id, version=1, schema_version=1, spec=spec, created_by=user_id, created_at=STORED
    )
    db_session.add(version)
    db_session.flush()
    row.current_version_id = version.id
    db_session.commit()
    return row, version.id


def _get(client, symbol: str = "PLTR", email: str = OWNER_EMAIL, **params):
    params = {"timeframe": "15m", "from": DAY_START, "to": DAY_END, **params}
    return client.get(PATH.format(symbol), params=params, headers=auth_headers(email))


def _minutes(stamp: str) -> int:
    moment = datetime.fromisoformat(stamp)
    return int(moment.timestamp() // 60)


def _starts(body: dict, pattern: str) -> list[str]:
    return sorted(m["bar_start"] for m in body["patterns"] if m["pattern"] == pattern)


def test_no_pattern_is_detected_unless_a_strategy_of_hers_uses_it(client, db_session):
    _user_id(client, db_session)
    _store(db_session, "PLTR")
    assert _get(client).json() == {"patterns": [], "fires": []}


def test_a_strategys_pattern_is_marked_where_its_own_condition_completes(client, db_session):
    owner = _user_id(client, db_session)
    _store(db_session, "PLTR")
    hammer = {"op": "pattern", "pattern": "hammer", "trend": "after_downtrend", "trendBars": 5}
    _strategy(db_session, owner, "Hammer 15m", hammer)

    body = _get(client).json()

    assert {m["pattern"] for m in body["patterns"]} == {"hammer"}
    assert _starts(body, "hammer") == pattern_fixture.occurrences("hammer", "PLTR", "15m")
    first = body["patterns"][0]  # the snapshot's worked example: the 10:15 ET hammer
    assert (first["template"], first["bar_start"], first["bar_close"]) == (
        "hammer",
        "2026-10-23T14:15:00Z",
        "2026-10-23T14:30:00Z",
    )
    assert first["ohlc"] == [194.7, 194.81, 193.23, 194.38]


def test_the_strategys_trend_rule_decides_the_marker(client, db_session):
    owner = _user_id(client, db_session)
    _store(db_session, "PLTR")
    _strategy(
        db_session, owner, "Hammer in an uptrend", {"op": "pattern", "pattern": "hammer", "trend": "after_uptrend"}
    )
    assert _get(client).json()["patterns"] == []  # the 10:15 hammer follows a downtrend


def test_other_users_and_archived_strategies_add_no_patterns(client, db_session):
    owner = _user_id(client, db_session)
    other = _user_id(client, db_session, OTHER_EMAIL)
    _store(db_session, "PLTR")
    _strategy(db_session, other, "Hers", {"op": "pattern", "pattern": "hammer"})
    _strategy(db_session, owner, "Gone", {"op": "pattern", "pattern": "doji"}, archived=True)
    assert _get(client).json()["patterns"] == []


@pytest.mark.parametrize("symbol", ["PLTR", "MSFT", "SPY"])
def test_all_patterns_finds_exactly_the_snapshot_occurrences_on_the_15_minute_bars(client, db_session, symbol):
    _user_id(client, db_session)
    _store(db_session, symbol)

    body = _get(client, symbol, all_patterns="true").json()

    assert {m["pattern"] for m in body["patterns"]} <= {t.replace("-", "_") for t in TEMPLATES}
    for template in TEMPLATES:
        pattern = template.replace("-", "_")
        assert _starts(body, pattern) == pattern_fixture.occurrences(template, symbol, "15m"), template
    assert body["patterns"] == sorted(body["patterns"], key=lambda m: (m["bar_start"], m["pattern"]))
    assert all(m["template"] == m["pattern"].replace("_", "-") for m in body["patterns"])
    assert all(len(m["ohlc"]) == 4 and m["bar_close"] > m["bar_start"] for m in body["patterns"])


def test_the_range_filters_on_the_bar_start_and_the_lead_in_still_decides_the_trend(client, db_session):
    _user_id(client, db_session)
    _store(db_session, "PLTR")
    everything = _get(client, all_patterns="true").json()["patterns"]
    later = _get(client, all_patterns="true", **{"from": "2026-10-23T18:00:00Z"}).json()["patterns"]
    assert later == [m for m in everything if m["bar_start"] >= "2026-10-23T18:00:00Z"]
    assert later and len(later) < len(everything)
    between = _get(client, all_patterns="true", **{"from": "2026-10-23T14:15:00Z", "to": "2026-10-23T14:15:00Z"})
    assert {m["bar_start"] for m in between.json()["patterns"]} == {"2026-10-23T14:15:00Z"}


def test_other_timeframes_are_resampled_from_the_stored_minutes(client, db_session):
    owner = _user_id(client, db_session)
    _store(db_session, "PLTR")
    _strategy(db_session, owner, "Any doji", {"op": "pattern", "pattern": "doji"})

    five = _get(client, timeframe="5m").json()["patterns"]

    assert five and all(m["bar_close"] > m["bar_start"] for m in five)
    assert all(_minutes(m["bar_close"]) - _minutes(m["bar_start"]) == 5 for m in five)


def test_the_last_bin_of_a_four_hour_timeframe_closes_with_the_session(db_session):
    start, end, now = pd.Timestamp(DAY_START), pd.Timestamp(DAY_END), pd.Timestamp(STORED)
    _store(db_session, "PLTR")

    frame, close_of = _stored_bars(db_session, "PLTR", "4h", start, end, now)

    assert close_of(pd.Timestamp("2026-10-23T13:30:00Z")) == pd.Timestamp("2026-10-23T17:30:00Z")
    assert close_of(pd.Timestamp("2026-10-23T17:30:00Z")) == pd.Timestamp("2026-10-23T20:00:00Z")  # not 21:30
    assert pd.Timestamp("2026-10-23T17:30:00Z") in frame.index


def test_daily_markers_match_the_snapshot_and_close_at_the_regular_close(client, db_session):
    _user_id(client, db_session)
    _store(db_session, "AVGO")

    window = {"from": "2026-10-12T00:00:00Z"}  # the snapshot's ten sessions; the ten before them are lead-in
    body = _get(client, "AVGO", timeframe="1d", all_patterns="true", **window).json()

    for template in TEMPLATES:
        expected = [f"{day}T00:00:00Z" for day in pattern_fixture.occurrences(template, "AVGO", "1d")]
        assert _starts(body, template.replace("-", "_")) == expected, template
    doji = next(m for m in body["patterns"] if m["pattern"] == "doji" and m["bar_start"] == "2026-10-23T00:00:00Z")
    assert doji["bar_close"] == "2026-10-23T20:00:00Z"  # 16:00 ET


def test_fires_are_her_signals_for_the_symbol_in_the_range(client, db_session):
    owner = _user_id(client, db_session)
    other = _user_id(client, db_session, OTHER_EMAIL)
    mine, mine_version = _strategy(db_session, owner, "ORB 15m", {"op": "pattern", "pattern": "doji"})
    _, theirs_version = _strategy(db_session, other, "Hers", {"op": "pattern", "pattern": "doji"})
    stamps = [datetime(2026, 10, 23, 14, 0, tzinfo=UTC), datetime(2026, 10, 22, 14, 0, tzinfo=UTC)]
    rows = [
        Signal(strategy_version_id=mine_version, symbol="PLTR", bar_time=stamps[0], evidence={}, data_quality="eod"),
        Signal(strategy_version_id=mine_version, symbol="PLTR", bar_time=stamps[1], evidence={}, data_quality="eod"),
        Signal(strategy_version_id=mine_version, symbol="AAPL", bar_time=stamps[0], evidence={}, data_quality="eod"),
        Signal(strategy_version_id=theirs_version, symbol="PLTR", bar_time=stamps[0], evidence={}, data_quality="eod"),
    ]
    for row in rows:
        row.created_at = STORED
    db_session.add_all(rows)
    db_session.commit()

    body = _get(client).json()

    assert body["fires"] == [{"signal_id": rows[0].id, "strategy_name": mine.name, "bar_time": "2026-10-23T14:00:00Z"}]
    wide = _get(client, **{"from": "2026-10-22T00:00:00Z"}).json()["fires"]
    assert [f["signal_id"] for f in wide] == [rows[1].id, rows[0].id]  # oldest first


def test_a_symbol_with_no_stored_bars_a_future_and_a_bad_symbol(client, db_session):
    owner = _user_id(client, db_session)
    _strategy(db_session, owner, "Any doji", {"op": "pattern", "pattern": "doji"})
    assert _get(client, "ZZZZ").json() == {"patterns": [], "fires": []}
    assert _get(client, "%2FES").json() == {"patterns": [], "fires": []}
    assert client.get(PATH.format("ABC!"), headers=auth_headers()).status_code == 422
    assert client.get(PATH.format("PLTR")).status_code == 401


def test_without_from_the_default_span_ends_at_now(client, db_session):
    _user_id(client, db_session)
    _store(db_session, "PLTR")
    default = client.get(PATH.format("PLTR"), params={"all_patterns": "true"}, headers=auth_headers())
    explicit = _get(client, all_patterns="true", **{"from": "2026-10-13T21:00:00Z", "to": "2026-10-23T21:00:00Z"})
    assert default.json() == explicit.json()  # ten days back from the frozen now, 15 minute bars
    assert default.json()["patterns"]


def test_weekly_markers_start_on_monday_and_close_on_the_weeks_last_regular_close(client, db_session):
    owner = _user_id(client, db_session)
    _store(db_session, "SPY")
    _strategy(db_session, owner, "Doji", {"op": "pattern", "pattern": "doji"})
    _strategy(db_session, owner, "Engulfing", {"op": "pattern", "pattern": "bearish_engulfing"})

    body = _get(client, "SPY", timeframe="1w", **{"from": "2026-09-01T00:00:00Z"}).json()

    assert [(m["pattern"], m["bar_start"], m["bar_close"]) for m in body["patterns"]] == [
        ("doji", "2026-09-28T00:00:00Z", "2026-10-02T20:00:00Z"),
        ("bearish_engulfing", "2026-10-12T00:00:00Z", "2026-10-16T20:00:00Z"),
    ]
