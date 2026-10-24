"""The Technical E2E seed (`technical_seed.py`): the snapshot's dates move by whole sessions, its bars come back
out of the minutes split from them, and the world it writes is the one the browser specs and the alert-path
checks assume. The database tests run with `scripts/test-db.sh`; the rest need nothing."""

from datetime import UTC, date, datetime

import pandas as pd
import pytest
from clock import E2E_EMAIL, E2E_NOW
from sqlalchemy import func, select
from technical_seed import (
    BAR_SYMBOLS,
    DAILY_HISTORY_BLOCKS,
    SessionShift,
    daily_history,
    load_snapshot,
    seed_technical,
    split_minutes,
)

from ai_trading.core.bias import MIN_BARS
from ai_trading.db.models import (
    Alert,
    Bar1d,
    Bar1h,
    Bar1m,
    Delivery,
    FeedHealth,
    FilterMatch,
    FilterRun,
    Signal,
    Strategy,
    SymbolMetrics,
    UniverseSymbol,
    User,
)


def test_the_snapshot_moves_back_whole_sessions_and_keeps_its_times_of_day():
    shift = SessionShift.for_now(E2E_NOW)
    assert shift.offset == 6  # Fri 2026-10-23 back to Thu 2026-10-15: six sessions
    assert shift.day(date(2026, 10, 23)) == date(2026, 10, 15)
    assert shift.day(date(2026, 10, 19)) == date(2026, 10, 9)  # Monday lands on the Friday before the weekend
    assert shift.moment("2026-10-23 15:45") == datetime(2026, 10, 15, 19, 45, tzinfo=UTC)
    assert shift.moment("2026-10-23 04:00") == datetime(2026, 10, 15, 8, 0, tzinfo=UTC)


def test_a_clock_after_the_snapshot_is_refused():
    with pytest.raises(RuntimeError, match="on or before the snapshot"):
        SessionShift.for_now(datetime(2026, 10, 27, 21, 0, tzinfo=UTC))


@pytest.mark.parametrize("parts", [5, 15])
def test_split_minutes_resample_to_the_recorded_bar(parts):
    recorded = ["2026-10-23 10:00", 100.0, 103.5, 98.25, 101.0, 12_345.0]
    start = datetime(2026, 10, 15, 14, 0, tzinfo=UTC)
    minutes = pd.DataFrame(split_minutes(start, recorded, parts)).set_index("bar_start")
    assert len(minutes) == parts and minutes.index.is_monotonic_increasing
    assert (minutes["high"] >= minutes[["open", "close"]].max(axis=1)).all()
    assert (minutes["low"] <= minutes[["open", "close"]].min(axis=1)).all()
    assert minutes["open"].iloc[0] == 100.0 and minutes["close"].iloc[-1] == pytest.approx(101.0)
    assert minutes["high"].max() == 103.5 and minutes["low"].min() == 98.25
    assert minutes["volume"].sum() == pytest.approx(12_345.0)


def test_daily_history_reaches_the_bias_minimum_and_stays_continuous():
    recorded = load_snapshot()["symbols"]["NVDA"]["bars"]["1d"]["rows"]
    history = daily_history(recorded)
    assert len(history) == DAILY_HISTORY_BLOCKS * len(recorded) >= MIN_BARS
    assert history[-len(recorded) :] == recorded  # the recorded block is untouched
    block = len(recorded)
    for end in range(block, len(history), block):  # each block ends where the next one starts
        assert history[end - 1][4] == pytest.approx(history[end][1])
    assert all(row[3] <= min(row[1], row[4]) and row[2] >= max(row[1], row[4]) for row in history)


def _user(db_session) -> int:
    user = User(email=E2E_EMAIL, settings={"e2e_unknown": {"keep": True}})
    db_session.add(user)
    db_session.flush()
    return user.id


def test_the_technical_world_is_complete_and_drafts_only(db_session):
    user_id = _user(db_session)
    report = seed_technical(db_session, user_id)
    db_session.commit()

    assert (report.watchlists, report.filters, report.alert_strategies) == (2, 10, 5)
    for symbol in BAR_SYMBOLS:
        for model in (Bar1d, Bar1h, Bar1m):
            assert db_session.scalar(select(func.count()).select_from(model).where(model.symbol == symbol)) > 0
    assert db_session.scalar(select(func.count()).select_from(Bar1d).where(Bar1d.symbol == "NVDA")) >= MIN_BARS
    assert db_session.scalar(select(func.count()).select_from(UniverseSymbol)) == 53
    assert db_session.scalar(select(func.count()).select_from(SymbolMetrics)) == 53
    assert db_session.scalar(select(func.count()).select_from(FilterRun)) == 10
    assert db_session.scalar(select(func.count()).select_from(FilterMatch)) > 10
    assert {feed.feed for feed in db_session.scalars(select(FeedHealth))} == {"bars_delayed", "scan"}
    assert set(db_session.scalars(select(Strategy.stage))) == {"draft"}  # seeds ship as drafts: nothing can alert
    assert db_session.scalar(select(func.count()).select_from(Alert)) == 0

    newest = db_session.scalar(select(func.max(Bar1m.bar_start)))
    assert newest < E2E_NOW  # nothing in the future of the frozen clock
    assert db_session.scalar(select(func.max(FilterRun.evaluation_point))) < E2E_NOW


def test_the_alert_history_has_one_log_row_of_each_kind(db_session):
    user_id = _user(db_session)
    seed_technical(db_session, user_id, alerts=True)
    db_session.commit()

    assert db_session.scalar(select(func.count()).select_from(Signal)) == 4
    assert db_session.scalar(select(func.count()).select_from(Alert)) == 4
    assert db_session.scalar(select(func.count()).select_from(Alert).where(Alert.read_at.is_(None))) == 3
    stages = {name: stage for name, stage in db_session.execute(select(Strategy.name, Strategy.stage))}
    assert stages.pop("Abnormal volume") == "draft" and set(stages.values()) == {"alert_only"}
    by_channel = sorted(db_session.execute(select(Delivery.channel, Delivery.status)))
    assert by_channel == [
        ("inbox", "sent"),
        ("inbox", "sent"),
        ("inbox", "sent"),
        ("inbox", "sent"),
        ("telegram", "failed"),
        ("telegram", "no_channel"),
        ("telegram", "sent"),
        ("telegram", "skipped_quiet_hours"),
    ]
    user = db_session.get(User, user_id)
    assert user.settings == {"e2e_unknown": {"keep": True}}  # the quiet hours used for the held row are not kept
