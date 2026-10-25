"""The daily consensus snapshot (02n §d, 02f §4): what is stored per feed, failure isolation, once-a-day idempotency,
dated history, and the scheduler hook. Network-free (fake sources); the store tests need Postgres
(`scripts/test-db.sh`)."""

from datetime import UTC, date, datetime, timedelta

import pandas as pd
from ai_trading_common import types as common
from ai_trading_common.errors import NoData, Unavailable
from ai_trading_common.registry import DataSources
from sqlalchemy import delete, insert, select

from ai_trading.db.models import (
    AnalystTarget,
    ConsensusSnapshot,
    EarningsResult,
    FeedHealth,
    WatchlistItem,
)
from ai_trading.jobs import JobResult, consensus_snapshot, scheduler
from ai_trading.jobs.clock import JobClock
from ai_trading.research import consensus

DAY = date(2026, 10, 6)  # a Tuesday session, EDT
AFTER_CLOSE = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)  # 16:30 ET
NEXT_DAY = AFTER_CLOSE + timedelta(days=1)
PERIOD = date(2026, 12, 31)


class FakeFeed:
    """One kind's source double: answers `build(symbol)` unless the symbol is listed as down or without data."""

    def __init__(self, build, *, down=(), no_data=()):
        self.build, self.down, self.no_data, self.calls = build, set(down), set(no_data), []

    def answer(self, symbol, now):
        self.calls.append(symbol)
        if symbol in self.down or "*" in self.down:
            raise Unavailable("fake", f"{symbol} is down https://example.invalid/?apikey=secret")
        if symbol in self.no_data:
            raise NoData("fake", f"nothing for {symbol}")
        return self.build(symbol, now)

    def consensus(self, symbol, *, now):
        return self.answer(symbol, now)

    def earnings_results(self, symbol, *, now):
        return self.answer(symbol, now)

    def analyst_targets(self, symbol, *, now):
        return self.answer(symbol, now)


def estimates(symbol, now, mean=2.0):
    return [
        common.ConsensusSnapshot(
            symbol, PERIOD, "quarter", 2026, 4, mean, mean + 0.2, mean - 0.2, 20, "fake", "eod", now
        ),
        common.ConsensusSnapshot(
            symbol, date(2027, 12, 31), "annual", 2027, None, mean * 4, None, None, 25, "fake", "eod", now
        ),
    ]


def results(symbol, now):
    return [
        common.EarningsResult(
            symbol, date(2026, 9, 30), 2026, 3, date(2026, 10, 22), "amc", 1.9, 2.1, 0.2, 10.5, "fake", "eod", now
        ),
        common.EarningsResult(
            symbol, None, None, None, date(2027, 1, 20), None, 2.0, None, None, None, "fake", "eod", now
        ),
    ]


def targets(symbol, now):
    return common.AnalystTargets(
        symbol, 210.0, 205.0, 250.0, 150.0, 5, 12, 8, 1, 0, "fake", "eod", now, period=date(2026, 10, 1)
    )


def sources(consensus_=None, earnings=None, targets_=None) -> DataSources:
    unused = object()
    return DataSources(
        bars=unused,
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=consensus_ or FakeFeed(estimates),
        earnings=earnings or FakeFeed(results),
        targets=targets_ or FakeFeed(targets),
        universe=unused,
        quotes=unused,
    )


def watch(db_session, watchlist_id, *symbols):
    for symbol in symbols:
        db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol=symbol, asset_type="stock"))
    db_session.commit()


def count(db_session, model) -> int:
    return len(db_session.execute(select(model)).scalars().all())


def health(db_session, feed):
    db_session.expire_all()
    return db_session.get(FeedHealth, feed)


# -- what is stored ------------------------------------------------------------------------------------------


def test_each_feed_is_stored_for_every_watchlist_stock_and_never_a_future(db_session, watchlist_with_items):
    watch(db_session, watchlist_with_items, "MSFT")  # the fixture already holds AAPL (stock) and ES (future)

    reports = consensus.snapshot_pass(db_session, sources(), now=AFTER_CLOSE)
    db_session.commit()

    assert set(reports) == {"consensus", "earnings", "targets"}
    assert all(report.state == "ok" for report in reports.values())
    rows = db_session.execute(
        select(ConsensusSnapshot).order_by(ConsensusSnapshot.symbol, ConsensusSnapshot.period_end)
    )
    stored = rows.scalars().all()
    assert [(r.symbol, r.period_kind, r.period_end, r.snapshot_date) for r in stored] == [
        ("AAPL", "quarter", PERIOD, DAY),
        ("AAPL", "annual", date(2027, 12, 31), DAY),
        ("MSFT", "quarter", PERIOD, DAY),
        ("MSFT", "annual", date(2027, 12, 31), DAY),
    ]
    quarter = stored[0]
    assert (quarter.eps_mean, quarter.eps_high, quarter.eps_low, quarter.analyst_count) == (2.0, 2.2, 1.8, 20)
    assert (quarter.provider, quarter.quality) == ("fake", "eod")
    assert quarter.as_of == AFTER_CLOSE and quarter.captured_at == AFTER_CLOSE
    # the calendar row without a fiscal period has no key and is skipped
    periods = {(r.symbol, r.period_end) for r in db_session.execute(select(EarningsResult)).scalars()}
    assert periods == {("AAPL", date(2026, 9, 30)), ("MSFT", date(2026, 9, 30))}
    target = db_session.get(AnalystTarget, ("AAPL", DAY))
    assert (target.target_mean, target.target_low, target.target_high) == (210.0, 150.0, 250.0)
    assert (target.strong_buy, target.buy, target.hold, target.sell, target.strong_sell) == (5, 12, 8, 1, 0)
    assert target.period == date(2026, 10, 1)
    assert all(health(db_session, feed).state == "ok" for feed in consensus.FEEDS)


def test_the_snapshot_day_is_the_eastern_trading_day_not_the_utc_date(db_session, watchlist_with_items):
    late = datetime(2026, 10, 7, 0, 30, tzinfo=UTC)  # 20:30 ET on the 6th, already the 7th in UTC

    consensus.snapshot_pass(db_session, sources(), now=late)
    db_session.commit()

    assert {r.snapshot_date for r in db_session.execute(select(ConsensusSnapshot)).scalars()} == {DAY}
    assert db_session.get(AnalystTarget, ("AAPL", DAY)) is not None


def test_a_naive_provider_timestamp_is_stored_as_utc():
    row = consensus._row(
        estimates("AAPL", pd.Timestamp("2026-10-06 20:30"))[0], snapshot_date=DAY, captured_at=AFTER_CLOSE
    )
    assert row["as_of"] == AFTER_CLOSE


# -- once a day, idempotent ----------------------------------------------------------------------------------


def test_a_finished_feed_is_not_fetched_again_even_across_the_utc_midnight_roll(db_session, watchlist_with_items):
    feeds = sources()
    consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE)
    db_session.commit()
    calls = len(feeds.consensus.calls)

    again = consensus.snapshot_pass(db_session, feeds, now=datetime(2026, 10, 7, 0, 5, tzinfo=UTC))  # same ET day
    db_session.commit()

    assert again == {}
    assert len(feeds.consensus.calls) == calls
    assert count(db_session, ConsensusSnapshot) == 2


def test_a_repeat_run_of_the_same_day_replaces_rows_instead_of_duplicating_them(db_session, watchlist_with_items):
    consensus.snapshot_pass(db_session, sources(), now=AFTER_CLOSE)
    db_session.commit()
    db_session.execute(delete(FeedHealth))  # as if the day's run had to be redone
    db_session.commit()

    later = AFTER_CLOSE + timedelta(hours=1)
    revised = sources(consensus_=FakeFeed(lambda s, now: estimates(s, now, mean=2.5)))
    consensus.snapshot_pass(db_session, revised, now=later)
    db_session.commit()

    db_session.expire_all()
    rows = (
        db_session.execute(select(ConsensusSnapshot).where(ConsensusSnapshot.period_kind == "quarter")).scalars().all()
    )
    assert [(r.eps_mean, r.captured_at) for r in rows] == [(2.5, later)]
    assert count(db_session, ConsensusSnapshot) == 2
    assert count(db_session, AnalystTarget) == 1
    assert count(db_session, EarningsResult) == 1


def test_each_day_adds_a_dated_snapshot_and_keeps_the_old_ones(db_session, watchlist_with_items):
    consensus.snapshot_pass(db_session, sources(), now=AFTER_CLOSE)
    db_session.commit()
    consensus.snapshot_pass(
        db_session, sources(consensus_=FakeFeed(lambda s, now: estimates(s, now, mean=2.4))), now=NEXT_DAY
    )
    db_session.commit()

    history = db_session.execute(
        select(ConsensusSnapshot.snapshot_date, ConsensusSnapshot.eps_mean)
        .where(ConsensusSnapshot.period_kind == "quarter")
        .order_by(ConsensusSnapshot.snapshot_date)
    ).all()
    assert history == [(DAY, 2.0), (DAY + timedelta(days=1), 2.4)]
    assert [r.snapshot_date for r in db_session.execute(select(AnalystTarget)).scalars()] == [
        DAY,
        DAY + timedelta(days=1),
    ]
    assert count(db_session, EarningsResult) == 1  # a reported period is one row, replaced by the latest answer


def test_duplicate_periods_in_one_answer_do_not_break_the_insert(db_session, watchlist_with_items):
    twice = sources(consensus_=FakeFeed(lambda s, now: estimates(s, now, mean=2.0) + estimates(s, now, mean=3.0)))

    consensus.snapshot_pass(db_session, twice, now=AFTER_CLOSE)
    db_session.commit()

    quarter = db_session.execute(
        select(ConsensusSnapshot).where(ConsensusSnapshot.period_kind == "quarter")
    ).scalar_one()
    assert quarter.eps_mean == 3.0  # the last of the equal keys wins


# -- failure isolation ---------------------------------------------------------------------------------------


def test_one_symbols_failure_is_recorded_without_its_message_and_the_pass_goes_on(db_session, watchlist_with_items):
    watch(db_session, watchlist_with_items, "MSFT", "NVDA")
    feeds = sources(consensus_=FakeFeed(estimates, down={"MSFT"}))

    reports = consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE)
    db_session.commit()

    assert reports["consensus"].failed == {"MSFT": "Unavailable"}
    assert reports["consensus"].state == "degraded"
    assert {r.symbol for r in db_session.execute(select(ConsensusSnapshot)).scalars()} == {"AAPL", "NVDA"}
    row = health(db_session, "consensus")
    assert row.state == "degraded" and row.last_ok_at == AFTER_CLOSE
    assert "secret" not in row.detail and "example.invalid" not in row.detail
    assert reports["earnings"].state == reports["targets"].state == "ok"  # the other feeds are untouched


def test_no_data_for_a_symbol_is_not_a_failure(db_session, watchlist_with_items):
    watch(db_session, watchlist_with_items, "BRK.B")
    feeds = sources(consensus_=FakeFeed(estimates, no_data={"BRK.B"}))

    reports = consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE)
    db_session.commit()

    assert reports["consensus"].failed == {} and reports["consensus"].state == "ok"
    assert {r.symbol for r in db_session.execute(select(ConsensusSnapshot)).scalars()} == {"AAPL"}


def test_five_failures_in_a_row_stop_that_feed_only(db_session, watchlist_with_items):
    watch(db_session, watchlist_with_items, "A", "B", "C", "D", "E", "F")
    feeds = sources(consensus_=FakeFeed(estimates, down={"*"}))

    reports = consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE)
    db_session.commit()

    assert reports["consensus"].stopped_early and reports["consensus"].state == "down"
    assert len(feeds.consensus.calls) == 5  # A, AAPL, B, C, D; the sixth symbol was never asked
    assert reports["targets"].state == "ok" and count(db_session, AnalystTarget) == 7
    down = health(db_session, "consensus")
    assert down.state == "down" and down.last_ok_at is None


def test_a_down_feed_is_retried_alone_and_a_finished_one_is_not_called(db_session, watchlist_with_items):
    flaky = FakeFeed(estimates, down={"*"})
    feeds = sources(consensus_=flaky)
    consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE)
    db_session.commit()
    targets_calls = len(feeds.targets.calls)

    flaky.down.clear()
    retry = consensus.snapshot_pass(db_session, feeds, now=AFTER_CLOSE + timedelta(minutes=1))
    db_session.commit()

    assert set(retry) == {"consensus"} and retry["consensus"].state == "ok"
    assert len(feeds.targets.calls) == targets_calls
    assert count(db_session, ConsensusSnapshot) == 2


# -- the job hook --------------------------------------------------------------------------------------------


def test_due_now_is_the_after_close_slot_on_trading_days_only():
    assert not consensus_snapshot.due_now(datetime(2026, 10, 6, 20, 29, tzinfo=UTC))  # 16:29 ET
    assert consensus_snapshot.due_now(AFTER_CLOSE)
    assert consensus_snapshot.due_now(datetime(2026, 10, 7, 2, 0, tzinfo=UTC))  # 22:00 ET: the window stays open
    assert not consensus_snapshot.due_now(datetime(2026, 10, 10, 21, 0, tzinfo=UTC))  # a Saturday


def test_run_marks_the_clock_when_every_feed_finished(db_session, watchlist_with_items):
    clock = JobClock()

    first = consensus_snapshot.run(db_session, sources(), clock, now=AFTER_CLOSE)
    db_session.commit()
    second = consensus_snapshot.run(db_session, sources(), clock, now=AFTER_CLOSE + timedelta(minutes=1))

    assert first == JobResult("consensus_snapshot", ok=True, ran=True)
    assert second == JobResult("consensus_snapshot", ok=True, ran=False)
    assert clock.succeeded_today("consensus_snapshot", AFTER_CLOSE)


def test_run_fails_without_marking_the_clock_while_a_feed_is_down(db_session, watchlist_with_items):
    clock = JobClock()

    result = consensus_snapshot.run(db_session, sources(targets_=FakeFeed(targets, down={"*"})), clock, now=AFTER_CLOSE)

    assert result == JobResult("consensus_snapshot", ok=False, error="targets: no provider answered")
    assert not clock.succeeded_today("consensus_snapshot", AFTER_CLOSE)


def test_the_scheduler_runs_it_after_daily_close_once_a_day(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "consensus_snapshot", lambda now: True)
    calls = []

    def _succeed(s, d, c, *, now):
        calls.append(now)
        c.mark("consensus_snapshot", now.date())
        return JobResult("consensus_snapshot", True)

    monkeypatch.setattr(consensus_snapshot, "run", _succeed)
    clock = JobClock()

    first = scheduler.run_due(object(), object(), clock, now=AFTER_CLOSE)
    second = scheduler.run_due(object(), object(), clock, now=AFTER_CLOSE + timedelta(minutes=1))

    assert calls == [AFTER_CLOSE]
    assert first == [JobResult("consensus_snapshot", True)]
    assert second == [JobResult("consensus_snapshot", ok=True, ran=False)]
    assert (
        scheduler._ORDER.index("daily_close")
        < scheduler._ORDER.index("consensus_snapshot")
        < scheduler._ORDER.index("watchdog")
    )
