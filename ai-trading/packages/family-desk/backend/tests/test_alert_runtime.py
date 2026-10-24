"""The alert runtime (02m §b5, §d3): who runs, never on stale data, no catch-up burst, frequency and cooldown
across versions, the rendered message, inbox-first deliveries, and the state `/status` reports. Needs a real
Postgres (`scripts/test-db.sh`)."""

from datetime import UTC, date, datetime, timedelta

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days
from sqlalchemy import func, select

from ai_trading.alerts.runtime import (
    alert_state,
    bar_close,
    delivery_channels,
    recent_cutoff,
    render_message,
    stale_limit,
    tick,
)
from ai_trading.core.calendar import et
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import (
    Alert,
    Delivery,
    FeedHealth,
    FilterMatch,
    FilterRun,
    Signal,
    Strategy,
    StrategyVersion,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.screener import service as filters

DAY = date(2026, 10, 6)  # a Tuesday, a regular session
STORED_AT = et(DAY, "20:00")  # the minutes are stored as of the end of the extended session
CROSS = {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100.5}}


def _bins(bars: pd.DataFrame, *starts: str) -> pd.DataFrame:
    """A 15-minute stretch of 101 starting at each `HH:MM` (ET) in `starts`: one cross above 100.5 per start."""
    for start in starts:
        first = et(DAY, start)
        for minute in range(15):
            at = (first + pd.Timedelta(minutes=minute)).tz_convert("America/New_York")
            set_bar(bars, DAY, at.strftime("%H:%M"), close=101.0)
    return bars


def _spec(*, run_on="bar_close_15m", when=None, universe=None, alert=None, limits=None, **extra) -> dict:
    spec = {
        "schemaVersion": 1,
        "name": "Cross",
        "watch": {"universe": universe or {"watchlist": "Mine"}, "session": "regular", "runOn": run_on},
        "when": when or CROSS,
        "then": {"alert": {"channels": ["inbox"], **(alert or {})}},
    }
    if limits:
        spec["limits"] = limits
    spec.update(extra)
    return spec


@pytest.fixture
def owner(db_session) -> int:
    user = User(email="owner@example.com", settings={})
    db_session.add(user)
    db_session.flush()
    watchlist = Watchlist(user_id=user.id, name="Mine", horizon="intraday")
    db_session.add(watchlist)
    db_session.flush()
    db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol="AAPL", asset_type="stock", position=0))
    db_session.commit()
    return user.id


def _strategy(db_session, owner_id: int, spec: dict, *, stage="alert_only", paused=None, archived=False, name="Cross"):
    row = Strategy(
        owner_user_id=owner_id,
        name=name,
        stage=stage,
        lane="technical",
        paused_reason=paused,
        archived_at=STORED_AT if archived else None,
        created_at=STORED_AT,
    )
    db_session.add(row)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=row.id, version=1, schema_version=1, spec=spec, created_by=owner_id, created_at=STORED_AT
    )
    db_session.add(version)
    db_session.flush()
    row.current_version_id = version.id
    db_session.commit()
    return row, version


def _store(db_session, symbol: str, minutes: pd.DataFrame, closes_before: int = 30) -> None:
    upsert_bars(db_session, symbol, "1m", minutes, "alpaca", "stock", now=STORED_AT)
    upsert_bars(
        db_session,
        symbol,
        "1d",
        daily_bars(trading_days("stock", DAY, closes_before), [100.0] * closes_before),
        "alpaca",
        "stock",
        now=STORED_AT,
    )
    db_session.commit()


def _healthy(db_session, now: datetime) -> None:
    db_session.merge(FeedHealth(feed="bars_delayed", state="ok", last_ok_at=now, updated_at=now))
    db_session.commit()


def _count(db_session, model) -> int:
    return db_session.scalar(select(func.count()).select_from(model))


def _setup(db_session, owner: int, minutes_at: tuple[str, ...] = ("10:30",), now_clock: str = "10:50", **spec_kwargs):
    row, version = _strategy(db_session, owner, _spec(**spec_kwargs))
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), *minutes_at))
    now = et(DAY, now_clock).to_pydatetime()
    _healthy(db_session, now)
    return row, version, now


# -- pure rules ---------------------------------------------------------------------------------------------


def test_the_message_fills_symbol_close_and_new_york_time():
    at = datetime(2026, 10, 6, 14, 45, tzinfo=UTC)  # 10:45 ET
    assert render_message(None, symbol="NVDA", close=212.4, at=at) == "NVDA 212.4 at 10:45 AM"
    assert render_message("{symbol} broke out at {close} ({time})", symbol="AMD", close=100.0, at=at) == (
        "AMD broke out at 100 (10:45 AM)"
    )
    assert render_message("{symbol} {close}", symbol="X", close=None, at=at) == "X n/a"
    noon = datetime(2026, 10, 6, 16, 5, tzinfo=UTC)
    midnight = datetime(2026, 10, 6, 4, 5, tzinfo=UTC)
    assert render_message("{time}", symbol="X", close=1, at=noon) == "12:05 PM"
    assert render_message("{time}", symbol="X", close=1, at=midnight) == "12:05 AM"
    afternoon = datetime(2026, 10, 6, 19, 30, tzinfo=UTC)
    assert render_message("{time}", symbol="X", close=1, at=afternoon) == "3:30 PM"


def test_inbox_is_first_and_never_repeated():
    assert delivery_channels(["telegram", "inbox", "slack", "telegram"]) == ["inbox", "telegram", "slack"]
    assert delivery_channels(["inbox"]) == ["inbox"]


def test_the_stale_limit_is_twice_the_cadence_plus_the_provider_delay():
    assert stale_limit("bar_close_15m", "delayed-15m") == timedelta(minutes=45)
    assert stale_limit("bar_close_1m", "delayed-15m") == timedelta(minutes=17)  # max(120 s, 2 min) + 15 min
    assert stale_limit("bar_close_5m", "realtime") == timedelta(minutes=10)
    assert stale_limit("bar_close_1h", "delayed-15m") == timedelta(minutes=135)


def test_a_bar_that_closed_before_the_recent_window_cannot_alert():
    as_of = pd.Timestamp(et(DAY, "11:00"))
    assert recent_cutoff("bar_close_15m", as_of, "delayed-15m") == as_of - pd.Timedelta(minutes=45)
    assert recent_cutoff("bar_close_1m", as_of, "realtime") == as_of - pd.Timedelta(minutes=2)
    assert recent_cutoff("daily_close", as_of, "eod") == et(date(2026, 10, 5), "00:00")  # the last session's point
    assert recent_cutoff("weekly", as_of, "eod") == as_of - pd.Timedelta(days=8)
    start = pd.Timestamp(et(DAY, "10:30"))
    assert bar_close("bar_close_15m", start) == pd.Timestamp(et(DAY, "10:45"))
    assert bar_close("daily_close", start) == start  # daily points are already the close


# -- firing -------------------------------------------------------------------------------------------------


def test_a_fresh_cross_writes_a_signal_an_alert_with_its_symbol_and_an_inbox_delivery(db_session, owner):
    row, version, now = _setup(db_session, owner)
    result = tick(db_session, now=now)
    assert (result.new_signals, result.errors, result.stale_symbols) == (1, [], 0)
    signal = db_session.execute(select(Signal)).scalar_one()
    assert (signal.symbol, signal.strategy_version_id, signal.bar_time) == ("AAPL", version.id, et(DAY, "10:30"))
    assert signal.data_quality == "delayed-15m"
    alert = db_session.execute(select(Alert)).scalar_one()
    assert (alert.symbol, alert.strategy_id, alert.user_id, alert.kind, alert.severity) == (
        "AAPL",
        row.id,
        owner,
        "signal",
        "info",
    )
    assert alert.title == "AAPL: Cross"
    assert alert.body == "AAPL 101 at 10:45 AM"
    assert alert.payload["strategy"] == "Cross" and alert.payload["evidence"] == {"close": 101.0}
    delivery = db_session.execute(select(Delivery)).scalar_one()
    assert (delivery.channel, delivery.status) == ("inbox", "pending")


def test_every_channel_gets_a_delivery_with_inbox_first_even_when_the_spec_omits_it(db_session, owner):
    _, _, now = _setup(db_session, owner, alert={"channels": ["telegram", "slack"]})
    tick(db_session, now=now)
    channels = db_session.execute(select(Delivery.channel).order_by(Delivery.id)).scalars().all()
    assert channels == ["inbox", "telegram", "slack"]


def test_the_spec_message_and_severity_are_used(db_session, owner):
    _, _, now = _setup(db_session, owner, alert={"message": "{symbol} cleared {close} at {time}", "severity": "risk"})
    tick(db_session, now=now)
    alert = db_session.execute(select(Alert)).scalar_one()
    assert (alert.body, alert.severity) == ("AAPL cleared 101 at 10:45 AM", "risk")


def test_a_restart_replaying_the_same_tick_writes_nothing_more(db_session, owner):
    _, _, now = _setup(db_session, owner)
    assert tick(db_session, now=now).new_signals == 1
    assert tick(db_session, now=now).new_signals == 0
    assert (_count(db_session, Signal), _count(db_session, Alert), _count(db_session, Delivery)) == (1, 1, 1)


def test_bars_that_closed_before_the_recent_window_are_a_missed_bar_not_an_alert(db_session, owner):
    _, _, now = _setup(db_session, owner, minutes_at=("09:30", "14:30"), now_clock="14:50")
    result = tick(db_session, now=now)
    assert result.new_signals == 1  # only the 14:30 cross; the 09:30 one closed five hours ago
    assert db_session.execute(select(Signal.bar_time)).scalar_one() == et(DAY, "14:30")


def test_a_paper_order_in_a_stored_spec_is_ignored(db_session, owner):
    order = {"side": "buy", "size": {"shares": 1}, "stop": {"pct": 1}, "target": {"pct": 2}}
    _, _, now = _setup(db_session, owner)
    version = db_session.execute(select(StrategyVersion)).scalar_one()
    version.spec = {**version.spec, "then": {**version.spec["then"], "paperOrder": order}}
    db_session.commit()
    assert tick(db_session, now=now).new_signals == 1  # the alert fires; no order object exists anywhere


def test_the_alert_fields_the_engine_gate_rejects_are_applied_here(db_session, owner):
    _, _, now = _setup(db_session, owner, alert={"frequency": "once", "expiresOn": "2026-10-06", "message": "{symbol}"})
    result = tick(db_session, now=now)
    assert result.errors == [] and result.new_signals == 1


# -- frequency, cooldown, expiry ----------------------------------------------------------------------------


def test_once_signals_a_symbol_a_single_time(db_session, owner):
    _, _, now = _setup(db_session, owner, minutes_at=("10:30", "11:00"), now_clock="11:20", alert={"frequency": "once"})
    result = tick(db_session, now=now)
    assert (result.new_signals, result.suppressed) == (1, 1)
    assert db_session.execute(select(Signal.bar_time)).scalar_one() == et(DAY, "10:30")


def test_once_per_bar_and_every_time_signal_each_bar_and_cooldown_limits_both(db_session, owner):
    _, _, now = _setup(db_session, owner, minutes_at=("10:30", "11:00"), now_clock="11:20")
    assert tick(db_session, now=now).new_signals == 2  # the default frequency is once_per_bar


def test_every_time_is_still_limited_by_the_cooldown(db_session, owner):
    _, _, now = _setup(
        db_session,
        owner,
        minutes_at=("10:30", "11:00"),
        now_clock="11:20",
        alert={"frequency": "every_time"},
        limits={"cooldownMinutes": 60},
    )
    result = tick(db_session, now=now)
    assert (result.new_signals, result.suppressed) == (1, 1)  # 11:00 is inside 60 minutes of 10:30


def test_a_short_cooldown_lets_both_through(db_session, owner):
    _, _, now = _setup(
        db_session, owner, minutes_at=("10:30", "11:00"), now_clock="11:20", limits={"cooldownMinutes": 20}
    )
    assert tick(db_session, now=now).new_signals == 2


def test_once_and_cooldown_look_across_versions(db_session, owner):
    row, first, now = _setup(
        db_session, owner, minutes_at=("10:30", "11:00"), now_clock="11:20", alert={"frequency": "once"}
    )
    db_session.add(
        Signal(
            strategy_version_id=first.id,
            symbol="AAPL",
            bar_time=et(DAY, "10:30"),
            evidence={},
            data_quality="delayed-15m",
            created_at=now,
        )
    )
    second = StrategyVersion(
        strategy_id=row.id, version=2, schema_version=1, spec=first.spec, created_by=owner, created_at=now
    )
    db_session.add(second)
    db_session.flush()
    row.current_version_id = second.id
    db_session.commit()
    result = tick(db_session, now=now)
    assert result.new_signals == 0  # once: version 1 already signalled this symbol
    assert result.suppressed >= 1


def test_the_same_bar_under_a_new_version_is_not_a_second_alert(db_session, owner):
    row, first, now = _setup(db_session, owner)
    assert tick(db_session, now=now).new_signals == 1
    second = StrategyVersion(
        strategy_id=row.id, version=2, schema_version=1, spec=first.spec, created_by=owner, created_at=now
    )
    db_session.add(second)
    db_session.flush()
    row.current_version_id = second.id
    db_session.commit()
    assert tick(db_session, now=now).new_signals == 0
    assert _count(db_session, Alert) == 1


def test_a_strategy_stops_the_day_after_its_expiry_date(db_session, owner):
    _, _, now = _setup(db_session, owner, alert={"expiresOn": "2026-10-05"})
    result = tick(db_session, now=now)
    assert result.new_signals == 0 and list(result.skipped_strategies.values()) == ["expired"]


def test_the_expiry_day_itself_still_runs(db_session, owner):
    _, _, now = _setup(db_session, owner, alert={"expiresOn": "2026-10-06"})
    assert tick(db_session, now=now).new_signals == 1


# -- who runs -----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs", [{"stage": "draft"}, {"paused": "user"}, {"archived": True}], ids=["draft", "paused", "archived"]
)
def test_a_draft_paused_or_archived_strategy_never_evaluates(db_session, owner, kwargs):
    _strategy(db_session, owner, _spec(), **kwargs)
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), "10:30"))
    now = et(DAY, "10:50").to_pydatetime()
    _healthy(db_session, now)
    result = tick(db_session, now=now)
    assert (result.evaluated_strategies, result.new_signals) == (0, 0)


def test_pause_all_stops_the_owners_strategies(db_session, owner):
    _, _, now = _setup(db_session, owner)
    db_session.get(User, owner).settings = {"pause_all": True}
    db_session.commit()
    result = tick(db_session, now=now)
    assert result.new_signals == 0 and list(result.skipped_strategies.values()) == ["paused by the owner"]


def test_only_the_requested_cadences_run(db_session, owner):
    _, _, now = _setup(db_session, owner)
    assert tick(db_session, now=now, live_cadences=frozenset({"daily_close"})).evaluated_strategies == 0


def test_a_future_symbol_never_evaluates(db_session, owner):
    _strategy(db_session, owner, _spec(universe={"symbols": ["/ES"]}))
    now = et(DAY, "10:50").to_pydatetime()
    _healthy(db_session, now)
    result = tick(db_session, now=now)
    assert (result.evaluated_strategies, result.new_signals, result.errors) == (0, 0, [])


# -- stale data ---------------------------------------------------------------------------------------------


def test_without_a_healthy_bars_feed_no_symbol_is_evaluated(db_session, owner):
    _strategy(db_session, owner, _spec())
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), "10:30"))
    now = et(DAY, "10:50").to_pydatetime()
    result = tick(db_session, now=now)  # no feed_health row at all
    assert (result.new_signals, result.stale_symbols, result.evaluated_strategies) == (0, 1, 0)
    db_session.merge(FeedHealth(feed="bars_delayed", state="down", last_ok_at=now, updated_at=now))
    db_session.commit()
    assert tick(db_session, now=now).stale_symbols == 1


def test_a_symbols_last_minute_older_than_the_limit_is_stale_and_recovery_has_no_burst(db_session, owner):
    _strategy(db_session, owner, _spec())
    minutes = _bins(minute_bars("stock", DAY), "10:30", "11:30")
    minutes = minutes[minutes.index < et(DAY, "11:00")]  # the feed stopped at 11:00 ET
    _store(db_session, "AAPL", minutes)
    _healthy(db_session, et(DAY, "13:00").to_pydatetime())
    stale = tick(
        db_session, now=et(DAY, "13:00").to_pydatetime()
    )  # two hours without a minute: past the 45 minute limit
    assert (stale.stale_symbols, stale.new_signals) == (1, 0)
    # Data returns for the 11:30 cross, but at 13:30 that bar closed 1h45m ago: a missed bar, not an alert.
    upsert_bars(
        db_session, "AAPL", "1m", _bins(minute_bars("stock", DAY), "10:30", "11:30"), "alpaca", "stock", now=STORED_AT
    )
    db_session.commit()
    _healthy(db_session, et(DAY, "13:30").to_pydatetime())
    recovered = tick(db_session, now=et(DAY, "13:30").to_pydatetime())
    assert (recovered.stale_symbols, recovered.new_signals) == (0, 0)


def test_daily_cadences_are_not_subject_to_the_minute_guard(db_session, owner):
    _strategy(
        db_session,
        owner,
        _spec(run_on="daily_close", when={"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}),
    )
    closes = [100.0] * 29 + [105.0]
    upsert_bars(
        db_session, "AAPL", "1d", daily_bars(trading_days("stock", DAY, 30), closes), "alpaca", "stock", now=STORED_AT
    )
    db_session.commit()
    result = tick(db_session, now=et(DAY, "16:30").to_pydatetime(), live_cadences=frozenset({"daily_close"}))
    assert (result.new_signals, result.stale_symbols) == (1, 0)  # no feed_health row, no minutes: still evaluated
    alert = db_session.execute(select(Alert)).scalar_one()
    assert alert.body == "AAPL 105 at 4:00 PM"


# -- sources ------------------------------------------------------------------------------------------------


def _filter_with_matches(db_session, owner: int, symbols: list[str], run_day: date):
    view = filters.create_from_spec(
        db_session,
        owner,
        {
            "schemaVersion": 1,
            "name": "Hot",
            "watch": {"universe": {"market": "us_equities"}, "session": "regular", "runOn": "daily_close"},
            "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 1}},
            "maxResults": 5,
        },
        now=STORED_AT,
    )
    run = FilterRun(
        filter_strategy_version_id=view.version.id,
        run_on="daily_close",
        session="regular",
        evaluation_point=et(run_day, "16:00").to_pydatetime(),
        scanned=1,
        no_data=0,
        matches_total=len(symbols),
        source="alpaca",
        quality="eod",
        created_at=STORED_AT,
    )
    db_session.add(run)
    db_session.flush()
    for rank, symbol in enumerate(symbols, start=1):
        db_session.add(
            FilterMatch(
                run_id=run.id,
                symbol=symbol,
                rank=rank,
                rank_value=1.0,
                matched_since=STORED_AT,
                operands={},
                columns={},
            )
        )
    db_session.commit()


def test_a_filter_source_evaluates_the_last_matches_while_the_run_is_fresh(db_session, owner):
    _filter_with_matches(db_session, owner, ["AAPL"], date(2026, 10, 5))  # the previous session: still fresh
    _strategy(db_session, owner, _spec(universe={"filter": "Hot"}))
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), "10:30"))
    now = et(DAY, "10:50").to_pydatetime()
    _healthy(db_session, now)
    assert tick(db_session, now=now).new_signals == 1


def test_a_filter_source_with_an_old_run_evaluates_nothing(db_session, owner):
    _filter_with_matches(db_session, owner, ["AAPL"], date(2026, 10, 2))  # two sessions back: too old to trust
    _strategy(db_session, owner, _spec(universe={"filter": "Hot"}))
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), "10:30"))
    now = et(DAY, "10:50").to_pydatetime()
    _healthy(db_session, now)
    assert tick(db_session, now=now).evaluated_strategies == 0


def test_a_symbol_list_source_and_unknown_sources_resolve_without_error(db_session, owner):
    _strategy(db_session, owner, _spec(universe={"symbols": ["AAPL"]}), name="Listed")
    _strategy(db_session, owner, _spec(universe={"watchlist": "Nope"}), name="Missing")
    _strategy(db_session, owner, _spec(universe={"filter": "Nope"}), name="NoFilter")
    _store(db_session, "AAPL", _bins(minute_bars("stock", DAY), "10:30"))
    now = et(DAY, "10:50").to_pydatetime()
    _healthy(db_session, now)
    result = tick(db_session, now=now)
    assert (result.new_signals, result.errors) == (1, [])


# -- state --------------------------------------------------------------------------------------------------


def test_alert_state_by_pause_strategies_feed_and_session(db_session, owner):
    open_now = et(DAY, "11:00").to_pydatetime()
    closed_now = et(date(2026, 10, 10), "11:00").to_pydatetime()  # a Saturday
    assert alert_state(db_session, owner, open_now) == "not_started"  # no live strategy
    _strategy(db_session, owner, _spec(), stage="draft")
    assert alert_state(db_session, owner, open_now) == "not_started"  # a draft is not live
    _strategy(db_session, owner, _spec(), name="Live")
    assert alert_state(db_session, owner, open_now) == "paused_no_quotes"  # the bars feed never ran
    assert alert_state(db_session, owner, closed_now) == "paused_no_quotes"  # never ran, even closed
    _healthy(db_session, open_now)
    assert alert_state(db_session, owner, open_now) == "running"
    assert alert_state(db_session, owner, open_now + timedelta(minutes=5)) == "running"
    assert (
        alert_state(db_session, owner, open_now + timedelta(hours=2)) == "paused_no_quotes"
    )  # stopped for 2 h in session
    assert alert_state(db_session, owner, closed_now) == "running"  # a closed market is not a stale feed
    db_session.get(User, owner).settings = {"pause_all": True}
    db_session.commit()
    assert alert_state(db_session, owner, open_now) == "paused_by_user"
