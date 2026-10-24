"""The "Her strategies" gauge (02m §a3.3): who votes on which timeframe, how the score and label follow
`core/bias.py`, and which strategies never count. Needs a real Postgres (`scripts/test-db.sh`)."""

from datetime import UTC, date, datetime, timedelta

import pytest
from bars import daily_bars, minute_bars, trading_days

from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Strategy, StrategyVersion, User, Watchlist, WatchlistItem
from ai_trading.strategies.votes import catalog_bias, strategies_gauge

DAY = date(2026, 10, 6)
NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)  # 17:00 ET: the regular session has closed
LATER = NOW + timedelta(hours=6)


def _spec(name: str, *, run_on: str = "bar_close_15m", above: float = 100.0, symbols=None) -> dict:
    return {
        "schemaVersion": 1,
        "name": name,
        "watch": {
            "universe": {"symbols": symbols} if symbols else {"watchlist": "Mine"},
            "session": "regular",
            "runOn": run_on,
        },
        "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": above}},
        "then": {"alert": {"channels": ["inbox"]}},
    }


@pytest.fixture
def user_id(db_session) -> int:
    user = User(email="owner@example.com", settings={})
    db_session.add(user)
    db_session.flush()
    watchlist = Watchlist(user_id=user.id, name="Mine", horizon="intraday")
    db_session.add(watchlist)
    db_session.flush()
    db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol="AAA", asset_type="stock", position=0))
    upsert_bars(
        db_session, "AAA", "1d", daily_bars(trading_days("stock", DAY, 30), [100.0] * 30), "alpaca", "stock", now=NOW
    )
    upsert_bars(db_session, "AAA", "1m", minute_bars("stock", DAY, price=105.0), "alpaca", "stock", now=LATER)
    db_session.commit()
    return user.id


def _strategy(db_session, user_id: int, spec: dict, *, stage="alert_only", paused=None, archived=False) -> Strategy:
    row = Strategy(
        owner_user_id=user_id,
        name=spec["name"],
        stage=stage,
        lane="technical",
        paused_reason=paused,
        archived_at=NOW if archived else None,
        created_at=NOW,
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
    return row


def test_a_true_condition_votes_its_catalog_bias_and_a_false_one_is_watching(db_session, user_id):
    hammer = _strategy(db_session, user_id, _spec("Hammer"))  # bullish preset, true (105 > 100)
    shooting = _strategy(db_session, user_id, _spec("Shooting star"))  # bearish preset, true
    doji = _strategy(db_session, user_id, _spec("Doji"))  # neutral preset, true
    never = _strategy(db_session, user_id, _spec("Hanging man", above=500.0))  # bearish preset, false
    gauge = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert gauge["counts"] == {"buy": 1, "neutral": 1, "sell": 1}
    assert {v["strategy_id"]: (v["bias"], v["vote"]) for v in gauge["votes"]} == {
        hammer.id: ("bullish", "buy"),
        shooting.id: ("bearish", "sell"),
        doji.id: ("neutral", "neutral"),
    }
    assert gauge["watching"] == [{"strategy_id": never.id, "name": "Hanging man"}]
    assert (gauge["score"], gauge["label"]) == (0.0, "Neutral")


def test_the_score_and_label_follow_the_bias_thresholds(db_session, user_id):
    for name in ("Hammer", "Morning star", "Bullish engulfing"):
        _strategy(db_session, user_id, _spec(name))
    gauge = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert (gauge["score"], gauge["label"], gauge["counts"]["buy"]) == (1.0, "Strong Buy", 3)
    _strategy(db_session, user_id, _spec("Shooting star"))
    four = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert (four["score"], four["label"]) == (0.5, "Buy")  # (3 - 1) / 4, on the Buy side of the 0.5 line


def test_nothing_voting_leaves_a_gauge_with_no_score_and_nothing_attached_is_none(db_session, user_id):
    assert strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER) is None
    only = _strategy(db_session, user_id, _spec("Hammer", above=500.0))
    gauge = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert (gauge["label"], gauge["score"], gauge["votes"]) == ("warming up", None, [])
    assert gauge["watching"] == [{"strategy_id": only.id, "name": "Hammer"}]


def test_a_strategy_votes_only_on_its_own_timeframe_and_premarket_is_always_watching(db_session, user_id):
    one_minute = _strategy(db_session, user_id, _spec("EMA 9/21 cross", run_on="bar_close_1m"))
    daily = _strategy(db_session, user_id, _spec("Golden / death cross 50/200", run_on="daily_close", above=50.0))
    premarket = _strategy(db_session, user_id, _spec("Gap and go", run_on="premarket_0830"))
    on_5m = strategies_gauge(db_session, user_id, "AAA", "5m", now=LATER)
    assert [v["strategy_id"] for v in on_5m["votes"]] == [one_minute.id]  # bar_close_1m votes on the 5m view
    assert [w["strategy_id"] for w in on_5m["watching"]] == [premarket.id]
    on_15m = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert on_15m["votes"] == [] and [w["strategy_id"] for w in on_15m["watching"]] == [premarket.id]
    on_1d = strategies_gauge(db_session, user_id, "AAA", "1d", now=LATER)
    assert [v["strategy_id"] for v in on_1d["votes"]] == [daily.id]
    assert strategies_gauge(db_session, user_id, "AAA", "1h", now=LATER)["watching"][0]["strategy_id"] == premarket.id


def test_drafts_paused_archived_expired_and_other_symbols_never_count(db_session, user_id):
    _strategy(db_session, user_id, _spec("Hammer"), stage="draft")
    _strategy(db_session, user_id, _spec("Doji"), paused="user")
    _strategy(db_session, user_id, _spec("Inside bar"), archived=True)
    expired = _spec("Piercing line")
    expired["then"]["alert"]["expiresOn"] = "2026-10-05"
    _strategy(db_session, user_id, expired)
    _strategy(db_session, user_id, _spec("Tweezer top", symbols=["ZZZ"]))
    assert strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER) is None
    assert strategies_gauge(db_session, user_id, "/ES", "15m", now=LATER) is None


def test_pause_all_silences_the_gauge(db_session, user_id):
    _strategy(db_session, user_id, _spec("Hammer"))
    assert strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER) is not None
    user = db_session.get(User, user_id)
    user.settings = {"pause_all": True}
    db_session.commit()
    assert strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER) is None


def test_a_condition_the_engine_cannot_run_leaves_the_strategy_watching(db_session, user_id):
    spec = _spec("Hammer")
    spec["when"] = {"op": "pattern", "pattern": "hammer"}
    row = _strategy(db_session, user_id, spec)
    gauge = strategies_gauge(db_session, user_id, "AAA", "15m", now=LATER)
    assert gauge["votes"] == [] and gauge["watching"] == [{"strategy_id": row.id, "name": "Hammer"}]


def test_catalog_bias_matches_preset_labels_template_names_and_the_seed_names():
    assert catalog_bias("Hammer") == "bullish" and catalog_bias("hammer") == "bullish"
    assert catalog_bias("Shooting star") == "bearish"
    assert catalog_bias("Opening-range breakout (15 min)") == "bullish"  # the template's own name
    assert catalog_bias("ORB 15m") == "bullish" and catalog_bias("Hammer 15m near S1") == "bullish"
    assert catalog_bias("Abnormal volume") == "neutral"
    assert catalog_bias("My own idea") == "neutral"
