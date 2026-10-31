"""The market-data refresher (02m §b3): symbol isolation, feed health, catch-up, idempotency, stale-data behavior,
and the three job hooks. Network-free; the DB tests need Postgres (`scripts/test-db.sh`)."""

from datetime import UTC, date, datetime, timedelta

import pandas as pd
import pytest
from ai_trading_common.errors import NoData, Unavailable
from ai_trading_common.registry import DataSources
from ai_trading_common.types import ActiveSymbol, Mover
from bars import daily_bars, minute_bars, trading_days
from conftest import FakeBarsSource
from sqlalchemy import func, select

from ai_trading.alerts.runtime import feed_healthy
from ai_trading.cli.seed_technical import seed_user
from ai_trading.core.calendar import session as trading_session
from ai_trading.core.freshness import freshness, market_session
from ai_trading.data import refresher
from ai_trading.data.bars import upsert_bars
from ai_trading.data.metrics import store_metrics
from ai_trading.db.models import (
    Bar1m,
    FeedHealth,
    FilterRun,
    SymbolMetrics,
    UniverseDay,
    UniverseSymbol,
    Watchlist,
    WatchlistItem,
)
from ai_trading.jobs import daily_close, premarket, refresh_15m
from ai_trading.jobs.clock import JobClock

DAY = date(2026, 10, 6)  # a regular session, EDT
SESSION = trading_session("stock", DAY)
PREMARKET = datetime(2026, 10, 6, 12, 30, tzinfo=UTC)  # 08:30 ET
SATURDAY = datetime(2026, 10, 24, 15, 0, tzinfo=UTC)  # the weekend the refresher shipped: no session until Monday
TEN = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)  # 10:00 ET
TEN_FIFTEEN = TEN + timedelta(minutes=15)
CLOSE_PASS = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)  # 16:30 ET
INTERVAL = timedelta(minutes=15)


class FakeUniverse:
    def __init__(self, actives=(), movers=()):
        self.actives, self.movers_, self.calls = list(actives), list(movers), 0

    def assets(self):
        self.calls += 1
        return []

    def most_actives(self, by, top):
        self.calls += 1
        return [ActiveSymbol(s, 1.0, 1, "fake", "delayed-15m") for s in self.actives]

    def movers(self, top):
        self.calls += 1
        return [Mover(s, "gainer", 1.0, 10.0, "fake", "delayed-15m") for s in self.movers_]


class DownBars:
    """A bars source whose provider is down (or has nothing) for the listed symbols, else the fake's bars. With
    `timeframes`, only those timeframes are affected."""

    def __init__(self, inner: FakeBarsSource, *, down=(), no_data=(), timeframes=None):
        self.inner, self.down, self.no_data, self.timeframes = inner, set(down), set(no_data), timeframes

    def bars(self, symbol, timeframe, start, end, *, now):
        if self.timeframes is not None and timeframe not in self.timeframes:
            return self.inner.bars(symbol, timeframe, start, end, now=now)
        if symbol in self.down or "*" in self.down:
            raise Unavailable("fake", f"{symbol} is down https://example.invalid/?k=secret")
        if symbol in self.no_data:
            raise NoData("fake", f"nothing for {symbol}")
        return self.inner.bars(symbol, timeframe, start, end, now=now)


class WatchlistOnly:
    """The old test double: a `bars` source and nothing else, so `scan_enabled` is False."""

    def __init__(self, bars) -> None:
        self.bars = bars


def scanning(bars, universe: FakeUniverse | None = None) -> DataSources:
    unused = object()
    return DataSources(
        bars=bars,
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=unused,
        earnings=unused,
        targets=unused,
        universe=universe or FakeUniverse(),
        quotes=unused,
        trades=unused,
    )


def stored_minutes(db_session, symbol: str = "AAPL") -> int:
    return db_session.execute(select(func.count()).select_from(Bar1m).where(Bar1m.symbol == symbol)).scalar_one()


def health(db_session, feed: str) -> FeedHealth | None:
    db_session.expire_all()
    return db_session.get(FeedHealth, feed)


def store_daily(db_session, symbol: str, count: int = 30, close: float = 100.0) -> None:
    days = trading_days("stock", DAY, count)
    upsert_bars(db_session, symbol, "1d", daily_bars(days[:-1], [close] * (count - 1)), "fake", "stock", now=TEN)


# -- failure isolation ---------------------------------------------------------------------------------------


def test_one_symbols_failure_is_recorded_and_the_pass_goes_on():
    seen = []

    def fetch(symbol):
        seen.append(symbol)
        if symbol == "BAD":
            raise Unavailable("fake", "nope")

    report = refresher._fetch_each(["AAA", "BAD", "CCC"], fetch)

    assert seen == ["AAA", "BAD", "CCC"]
    assert (report.fetched, report.failed, report.stopped_early) == (2, {"BAD": "Unavailable"}, False)
    assert report.state == "degraded"


def test_no_data_is_an_answer_not_a_failure():
    def fetch(symbol):
        raise NoData("fake", "nothing")

    report = refresher._fetch_each(["AAA", "BBB"], fetch)

    assert (report.fetched, report.failed) == (0, {})
    assert report.state == "empty"  # an answer, not a failure, but not a healthy pass either


def test_a_plain_exception_is_the_symbols_failure_and_the_pass_goes_on():
    seen = []

    def fetch(symbol):
        seen.append(symbol)
        if symbol == "BAD":
            raise RuntimeError("statement is too big")

    report = refresher._fetch_each(["AAA", "BAD", "CCC"], fetch)

    assert seen == ["AAA", "BAD", "CCC"]
    assert (report.fetched, report.failed, report.stopped_early) == (2, {"BAD": "RuntimeError"}, False)
    assert report.state == "degraded"


def test_plain_exceptions_count_toward_the_stop_streak():
    def fetch(symbol):
        raise RuntimeError("boom")

    report = refresher._fetch_each([f"S{i}" for i in range(9)], fetch)

    assert (len(report.failed), report.stopped_early, report.state) == (refresher.STOP_AFTER_FAILURES, True, "down")


def test_pass_state_tells_fetched_partial_empty_and_nothing_asked_apart():
    assert refresher._fetch_each(["AAA", "BBB"], lambda symbol: None).state == "ok"
    assert refresher.PassReport(fetched=1, failed={"X": "RuntimeError"}, expected=2).state == "degraded"
    assert refresher.PassReport(expected=3).state == "empty"
    assert refresher._fetch_each([], lambda symbol: None).state == "ok"  # a genuinely empty universe


def test_an_empty_pass_does_not_move_last_ok_at_and_says_why(db_session):
    report = refresher.PassReport(expected=4)
    refresher.record_health(db_session, "bars_delayed", "ok", now=TEN)
    refresher.record_health(db_session, "bars_delayed", report.state, now=TEN_FIFTEEN, detail=refresher._detail(report))

    row = health(db_session, "bars_delayed")
    assert (row.state, row.last_ok_at, row.detail) == ("empty", TEN, "nothing fetched for 4 symbols")


def test_five_failures_in_a_row_stop_the_pass_but_a_success_resets_the_run():
    attempts = []

    def fetch(symbol):
        attempts.append(symbol)
        if symbol != "OK":
            raise Unavailable("fake", "nope")

    broken = refresher._fetch_each([f"S{i}" for i in range(9)], fetch)
    assert len(attempts) == refresher.STOP_AFTER_FAILURES
    assert (broken.stopped_early, broken.state) == (True, "down")

    attempts.clear()
    order = ["S1", "S2", "S3", "S4", "OK", "S5", "S6", "S7", "S8", "S9", "S10"]
    refresher._fetch_each(order, fetch)
    assert attempts == order[:10]  # the success at index 4 reset the run, so the pass stopped five failures later


# -- the market strip ------------------------------------------------------------------------------------------


def test_every_pass_scans_the_market_strip_without_a_watchlist_or_a_universe(db_session):
    assert refresher._scan_symbols(db_session) == ["IWM", "QQQ", "SPY"]


def test_the_seed_stores_the_strip_rows_on_a_weekend_and_vouches_through_its_own_feed(db_session):
    bars = FakeBarsSource()

    report = refresher.seed_market_strip(db_session, scanning(bars), now=SATURDAY)
    db_session.commit()

    assert report.state == "ok"
    assert {call[0] for call in bars.calls} == {"SPY", "QQQ", "IWM"}
    assert {call[1] for call in bars.calls} == {"1d"}  # daily bars only: no minute history for a seed
    rows = {row.symbol: row for row in db_session.execute(select(SymbolMetrics)).scalars()}
    assert set(rows) == {"SPY", "QQQ", "IWM"} and rows["SPY"].metrics["last"] == 100.0
    assert rows["SPY"].quality == "eod" and rows["SPY"].as_of == datetime(2026, 10, 23, 20, 0, tzinfo=UTC)
    assert health(db_session, refresher.STRIP_FEED).state == "ok"
    # No minute bar or screener run stands behind a seed: the feeds the alerts and the watchdog read stay untouched.
    assert health(db_session, "bars_delayed") is None and health(db_session, "scan") is None


def test_ensure_seeds_once_a_strip_symbol_has_no_row_and_then_leaves_it_alone(db_session):
    bars = FakeBarsSource()
    assert refresher.ensure_market_strip(db_session, scanning(bars), now=SATURDAY) is True
    db_session.commit()
    seeded = len(bars.calls)

    assert refresher.ensure_market_strip(db_session, scanning(bars), now=SATURDAY + INTERVAL) is False
    assert len(bars.calls) == seeded  # every row exists: not one provider call


def test_ensure_does_nothing_for_a_data_source_without_the_universe_kind(db_session):
    bars = FakeBarsSource()
    assert refresher.ensure_market_strip(db_session, WatchlistOnly(bars), now=SATURDAY) is False
    assert bars.calls == []


def test_a_seed_that_found_nothing_waits_before_asking_again(db_session):
    down = DownBars(FakeBarsSource(), down={"*"})
    assert refresher.ensure_market_strip(db_session, scanning(down), now=SATURDAY) is True
    db_session.commit()
    assert health(db_session, refresher.STRIP_FEED).state == "down"
    assert db_session.execute(select(func.count()).select_from(SymbolMetrics)).scalar_one() == 0

    assert refresher.ensure_market_strip(db_session, scanning(down), now=SATURDAY + timedelta(minutes=1)) is False
    healed = FakeBarsSource()
    assert refresher.ensure_market_strip(db_session, scanning(healed), now=SATURDAY + refresher.STRIP_RETRY) is True
    db_session.commit()
    assert health(db_session, refresher.STRIP_FEED).state == "ok"


# -- feed health ----------------------------------------------------------------------------------------------


def test_a_down_feed_keeps_the_time_it_last_worked(db_session):
    refresher.record_health(db_session, "bars_delayed", "ok", now=TEN)
    refresher.record_health(db_session, "bars_delayed", "down", now=TEN_FIFTEEN, detail="5 failed (Unavailable)")
    row = health(db_session, "bars_delayed")
    assert (row.state, row.last_ok_at, row.updated_at, row.detail) == (
        "down",
        TEN,
        TEN_FIFTEEN,
        "5 failed (Unavailable)",
    )

    refresher.record_health(db_session, "bars_delayed", "degraded", now=TEN_FIFTEEN + INTERVAL)
    row = health(db_session, "bars_delayed")
    assert (row.state, row.last_ok_at, row.detail) == ("degraded", TEN_FIFTEEN + INTERVAL, None)


def test_a_feed_that_never_worked_has_no_last_ok_time(db_session):
    refresher.record_health(db_session, "bars_delayed", "down", now=TEN)
    assert health(db_session, "bars_delayed").last_ok_at is None


# -- the 15-minute pass ---------------------------------------------------------------------------------------


def test_the_intraday_pass_stores_minutes_metrics_the_bias_slot_and_health(db_session, watchlist_with_items):
    store_daily(db_session, "AAPL")
    bars = FakeBarsSource()

    report = refresher.intraday_pass(db_session, WatchlistOnly(bars), now=TEN)
    db_session.commit()

    assert (report.fetched, report.state) == (1, "ok")
    assert {call[0] for call in bars.calls} == {"AAPL"}  # ES is a future: stocks only
    assert stored_minutes(db_session) > 0
    row = db_session.get(SymbolMetrics, "AAPL")
    assert row.quality == "delayed-15m"
    assert "bias_15m" in row.metrics and row.metrics["bias_15m"] is None  # under 250 closed 15-minute bars
    assert health(db_session, "bars_delayed").state == "ok"
    assert health(db_session, "scan") is None  # no universe kind: the scan feed is not this pass's to write


def test_running_the_same_pass_twice_changes_nothing(db_session, watchlist_with_items):
    store_daily(db_session, "AAPL")
    sources = WatchlistOnly(FakeBarsSource())

    refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()
    first = stored_minutes(db_session)
    metrics = dict(db_session.get(SymbolMetrics, "AAPL").metrics)

    refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()
    db_session.expire_all()

    assert stored_minutes(db_session) == first > 0
    assert db_session.get(SymbolMetrics, "AAPL").metrics == metrics
    assert db_session.execute(select(func.count()).select_from(FeedHealth)).scalar_one() == 1


def test_a_pass_after_a_long_gap_resumes_from_the_last_stored_minute(db_session, watchlist_with_items):
    # The scheduler was down from 10:00 to 14:00 ET: the next pass stores every minute in between, fetching from
    # the last stored bar and not from the session's open.
    bars = FakeBarsSource()
    sources = WatchlistOnly(bars)
    refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()
    before = stored_minutes(db_session)
    bars.calls.clear()

    later = datetime(2026, 10, 6, 18, 0, tzinfo=UTC)  # 14:00 ET
    refresher.intraday_pass(db_session, sources, now=later)
    db_session.commit()

    (today_call,) = [c for c in bars.calls if c[1] == "1m" and c[3] == SESSION.extended_close]
    assert today_call[2] > SESSION.extended_open
    last = db_session.execute(select(func.max(Bar1m.bar_start)).where(Bar1m.symbol == "AAPL")).scalar_one()
    assert pd.Timestamp(last) == pd.Timestamp(later) - pd.Timedelta(minutes=1)  # the 13:59 ET bar closed at 14:00
    assert stored_minutes(db_session) > before


def test_a_new_symbol_gets_its_previous_sessions_in_one_request(db_session, watchlist_with_items):
    bars = FakeBarsSource()
    refresher.intraday_pass(db_session, WatchlistOnly(bars), now=TEN)

    history = [c for c in bars.calls if c[1] == "1m" and c[3] != SESSION.extended_close]
    assert len(history) == 1  # one contiguous range for the whole gap
    assert history[0][2] < SESSION.extended_open


def test_when_the_provider_is_down_the_feed_goes_down_and_keeps_its_last_good_time(db_session, watchlist_with_items):
    store_daily(db_session, "AAPL")
    bars = FakeBarsSource()
    refresher.intraday_pass(db_session, WatchlistOnly(bars), now=TEN)
    db_session.commit()
    metrics_as_of = db_session.get(SymbolMetrics, "AAPL").as_of

    report = refresher.intraday_pass(db_session, WatchlistOnly(DownBars(bars, down={"*"})), now=TEN_FIFTEEN)
    db_session.commit()

    assert (report.fetched, report.state) == (0, "down")
    row = health(db_session, "bars_delayed")
    assert (row.state, row.last_ok_at, row.updated_at) == ("down", TEN, TEN_FIFTEEN)
    assert row.detail == "1 failed (Unavailable)"  # the error class only: never the message or a URL
    assert db_session.get(SymbolMetrics, "AAPL").as_of == metrics_as_of  # nothing was recomputed from old data
    assert feed_healthy(db_session) is False  # the alert runtime skips live strategies


def test_stale_data_reads_paused_then_never_live_through_core_freshness(db_session):
    # What the API and the alert runtime show for a feed the refresher stopped updating: `core.freshness`
    # over `last_ok_at`, never a value stored here.
    refresher.record_health(db_session, "bars_delayed", "ok", now=TEN)
    last_ok = health(db_session, "bars_delayed").last_ok_at

    assert freshness("delayed-15m", market_session(TEN_FIFTEEN), last_ok, TEN_FIFTEEN, INTERVAL) == "delayed"
    stale = TEN + timedelta(minutes=31)  # more than max(120 s, 2 x 15 min) with no pass
    assert freshness("delayed-15m", market_session(stale), last_ok, stale, INTERVAL) == "paused"
    assert freshness("delayed-15m", market_session(TEN), None, TEN, INTERVAL) == "unavailable"
    after_close = datetime(2026, 10, 7, 3, 0, tzinfo=UTC)
    assert freshness("delayed-15m", market_session(after_close), last_ok, after_close, INTERVAL) == "closed"


def test_some_symbols_failing_marks_the_feed_degraded_and_still_advances_it(db_session, owner):
    watchlist = Watchlist(user_id=owner, name="core", horizon="swing")
    db_session.add(watchlist)
    db_session.flush()
    for symbol in ("AAPL", "MSFT", "NVDA"):
        db_session.add(WatchlistItem(watchlist_id=watchlist.id, symbol=symbol, asset_type="stock"))
    db_session.commit()
    for symbol in ("AAPL", "MSFT", "NVDA"):
        store_daily(db_session, symbol)
    sources = WatchlistOnly(DownBars(FakeBarsSource(), down={"MSFT"}, no_data={"NVDA"}))

    report = refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()

    assert (report.fetched, report.failed, report.state) == (1, {"MSFT": "Unavailable"}, "degraded")
    row = health(db_session, "bars_delayed")
    assert (row.state, row.last_ok_at, row.detail) == ("degraded", TEN, "1 failed (Unavailable)")
    assert stored_minutes(db_session, "AAPL") > 0
    assert stored_minutes(db_session, "MSFT") == stored_minutes(db_session, "NVDA") == 0


def test_the_bias_is_written_from_stored_regular_session_minutes(db_session, watchlist_with_items):
    store_daily(db_session, "AAPL")
    assert refresher.fifteen_minute_bias(db_session, "AAPL", pd.Timestamp(TEN)) is None  # no minutes at all

    for day in trading_days("stock", DAY, 12):  # 10+ sessions of 26 fifteen-minute bars clears the 250-bar warm-up
        frame = minute_bars("stock", day)
        regular = frame.loc[trading_session("stock", day).regular_open : trading_session("stock", day).regular_close]
        upsert_bars(db_session, "AAPL", "1m", regular.iloc[:-1], "fake", "stock", now=CLOSE_PASS + timedelta(days=1))
    label = refresher.fifteen_minute_bias(db_session, "AAPL", pd.Timestamp(CLOSE_PASS))

    assert isinstance(label, str) and label != "warming up"


def test_a_metrics_row_another_job_loaded_is_not_written_back_stale(db_session):
    # The scheduler runs several jobs on one session: an earlier job may still hold a loaded `SymbolMetrics`
    # instance when a later one recomputes the row with a Core upsert. The bias update must start from the fresh row.
    store_metrics(db_session, "AAPL", {"last": 1.0}, as_of=TEN, source="alpaca", quality="eod")
    loaded = db_session.get(SymbolMetrics, "AAPL")  # held, so it stays in the identity map
    assert loaded.metrics == {"last": 1.0}

    store_metrics(db_session, "AAPL", {"last": 2.0}, as_of=TEN_FIFTEEN, source="alpaca", quality="eod")
    refresher.refresh_bias(db_session, ["AAPL"], now=TEN_FIFTEEN)
    db_session.commit()
    db_session.expire_all()

    assert db_session.get(SymbolMetrics, "AAPL").metrics == {"last": 2.0, "bias_15m": None}


# -- the scan passes (universe kind present) -------------------------------------------------------------------


@pytest.fixture
def seeded(db_session, owner):
    seed_user(db_session, owner, now=PREMARKET)
    db_session.commit()
    return owner


def filter_runs(db_session, run_on: str) -> int:
    return db_session.execute(
        select(func.count()).select_from(FilterRun).where(FilterRun.run_on == run_on)
    ).scalar_one()


def test_the_premarket_pass_builds_the_universe_then_scans_it_once(db_session, seeded):
    universe = FakeUniverse(actives=["ZZZZ"])
    sources = scanning(FakeBarsSource(), universe)

    report = refresher.premarket_pass(db_session, sources, now=PREMARKET)
    db_session.commit()

    assert report.state == "ok"
    assert universe.calls == 4  # assets, most actives by volume and by trades, movers
    survivors = refresher.survivor_symbols(db_session)
    assert {"AAPL", "SPY", "NVDA"} <= set(survivors)  # the seeds and the market strip, always scanned
    assert health(db_session, "scan").state == "ok"
    assert health(db_session, "bars_delayed").state == "ok"
    assert db_session.get(SymbolMetrics, "AAPL").metrics["last"] == 100.0
    assert "ZZZZ" in survivors  # a provider-listed most-active joins the seeds
    runs = filter_runs(db_session, "premarket_0830")
    assert runs == 2  # gap up and gap down, the two seeded premarket filters
    universe_size = db_session.execute(select(func.count()).select_from(UniverseSymbol)).scalar_one()

    refresher.premarket_pass(db_session, sources, now=PREMARKET)  # a late or repeated run at the same point
    db_session.commit()

    assert filter_runs(db_session, "premarket_0830") == runs
    assert db_session.execute(select(func.count()).select_from(UniverseSymbol)).scalar_one() == universe_size


def test_the_premarket_pass_snapshots_the_universe_it_scanned_once_per_day(db_session, seeded):
    sources = scanning(FakeBarsSource(), FakeUniverse(actives=["ZZZZ"]))
    refresher.premarket_pass(db_session, sources, now=PREMARKET)
    db_session.commit()
    row = db_session.get(UniverseDay, DAY)
    assert row.symbols == refresher.survivor_symbols(db_session) and "ZZZZ" in row.symbols
    refresher.premarket_pass(db_session, sources, now=PREMARKET)  # a repeated run replaces the row, never doubles it
    db_session.commit()
    assert db_session.execute(select(func.count()).select_from(UniverseDay)).scalar_one() == 1


def test_a_failing_snapshot_never_fails_the_live_pass(db_session, seeded, monkeypatch):
    sources = scanning(FakeBarsSource(), FakeUniverse(actives=["ZZZZ"]))
    real = refresher.pg_insert

    def failing(model):
        if model is UniverseDay:
            raise RuntimeError("the snapshot table is gone")
        return real(model)

    monkeypatch.setattr(refresher, "pg_insert", failing)
    report = refresher.premarket_pass(db_session, sources, now=PREMARKET)
    db_session.commit()
    assert report.state == "ok" and filter_runs(db_session, "premarket_0830") == 2  # the scan went ahead regardless
    assert db_session.get(UniverseDay, DAY) is None


def test_the_15_minute_pass_rebuilds_a_universe_the_premarket_pass_never_built(db_session, seeded):
    # Catch-up: the scheduler started after 08:30 (or premarket failed), so no symbol has passed the floor yet.
    universe = FakeUniverse()
    sources = scanning(FakeBarsSource(), universe)
    assert refresher.survivor_symbols(db_session) == []

    report = refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()

    assert universe.calls > 0
    assert "AAPL" in refresher.survivor_symbols(db_session)
    assert report.state == "ok"
    assert (health(db_session, "bars_delayed").state, health(db_session, "scan").state) == ("ok", "ok")
    assert stored_minutes(db_session, "AAPL") > 0
    assert filter_runs(db_session, "bar_close_15m") == 2  # the intraday filters ran on the freshly stored minutes

    universe.calls = 0
    refresher.intraday_pass(db_session, sources, now=TEN_FIFTEEN)  # survivors exist now: no second rebuild
    assert universe.calls == 0


def test_the_daily_pass_refreshes_survivors_without_rebuilding_the_universe(db_session, seeded):
    universe = FakeUniverse()
    sources = scanning(FakeBarsSource(), universe)
    refresher.premarket_pass(db_session, sources, now=PREMARKET)
    db_session.commit()
    universe.calls = 0

    report = refresher.daily_pass(db_session, sources, now=CLOSE_PASS)
    db_session.commit()

    assert report.state == "ok"
    assert universe.calls == 0
    assert health(db_session, "scan").last_ok_at == CLOSE_PASS
    runs = filter_runs(db_session, "daily_close")
    assert runs > 0

    refresher.daily_pass(db_session, sources, now=CLOSE_PASS)
    db_session.commit()
    assert filter_runs(db_session, "daily_close") == runs


def test_a_dead_provider_leaves_the_scan_feed_down_and_runs_no_filter(db_session, seeded):
    sources = scanning(DownBars(FakeBarsSource(), down={"*"}))

    report = refresher.intraday_pass(db_session, sources, now=TEN)
    db_session.commit()

    assert report.state == "down"
    assert health(db_session, "bars_delayed").state == "down"
    assert health(db_session, "scan") is None
    assert filter_runs(db_session, "bar_close_15m") == 0


# -- the job hooks ---------------------------------------------------------------------------------------------


def test_the_premarket_job_runs_the_scan_pass_before_the_tick_and_marks_the_clock(db_session, seeded, monkeypatch):
    order = []
    monkeypatch.setattr(premarket, "tick", lambda session, *, now, live_cadences: order.append("tick"))
    real_pass = refresher.premarket_pass
    monkeypatch.setattr(refresher, "premarket_pass", lambda *a, **k: order.append("pass") or real_pass(*a, **k))
    clock = JobClock()

    result = premarket.run(db_session, clock, now=PREMARKET, data_sources=scanning(FakeBarsSource()))
    db_session.commit()

    assert result.ok is True
    assert order == ["pass", "tick"]
    assert clock.succeeded_today("premarket_0830", PREMARKET) is True
    assert db_session.execute(select(func.count()).select_from(UniverseSymbol)).scalar_one() > 0


def test_a_premarket_pass_with_daily_bars_but_no_minutes_is_degraded_not_down(db_session, seeded):
    sources = scanning(DownBars(FakeBarsSource(), down={"*"}, timeframes={"1m"}))

    report = refresher.premarket_pass(db_session, sources, now=PREMARKET)
    db_session.commit()

    assert report.state == "degraded"
    assert health(db_session, "bars_delayed").state == "down"  # the live strategies' guard still sees no minutes
    assert health(db_session, "scan").state == "degraded"


def test_the_premarket_job_does_not_spend_its_day_on_a_dead_provider_and_catches_up_later(
    db_session, seeded, monkeypatch
):
    ticked = []
    monkeypatch.setattr(premarket, "tick", lambda session, *, now, live_cadences: ticked.append(now))
    clock = JobClock()
    healthy = FakeBarsSource()

    failed = premarket.run(db_session, clock, now=PREMARKET, data_sources=scanning(DownBars(healthy, down={"*"})))
    db_session.commit()

    assert (failed.ok, failed.error) == (False, "market data unavailable")
    assert ticked == [] and clock.succeeded_today("premarket_0830", PREMARKET) is False

    later = PREMARKET + timedelta(minutes=7)  # the provider is back on a later scheduler tick
    caught_up = premarket.run(db_session, clock, now=later, data_sources=scanning(healthy))
    db_session.commit()

    assert caught_up.ok is True
    assert ticked == [later] and clock.succeeded_today("premarket_0830", later) is True
    assert filter_runs(db_session, "premarket_0830") == 2


def test_the_daily_close_job_waits_for_a_provider_that_is_down(db_session, seeded, monkeypatch):
    ticked = []
    monkeypatch.setattr(daily_close, "tick", lambda session, *, now, live_cadences: ticked.append(now))
    clock = JobClock()

    result = daily_close.run(db_session, scanning(DownBars(FakeBarsSource(), down={"*"})), clock, now=CLOSE_PASS)

    assert (result.ok, ticked, clock.succeeded_today("daily_close", CLOSE_PASS)) == (False, [], False)


def test_the_premarket_job_without_a_scan_source_only_ticks(monkeypatch):
    called = []
    monkeypatch.setattr(premarket, "tick", lambda session, *, now, live_cadences: called.append("tick"))
    monkeypatch.setattr(refresher, "premarket_pass", lambda *a, **k: called.append("pass"))
    clock = JobClock()

    premarket.run(object(), clock, now=PREMARKET)  # the old signature
    premarket.run(object(), clock, now=PREMARKET, data_sources=WatchlistOnly(FakeBarsSource()))

    assert called == ["tick", "tick"]


def test_the_15_minute_job_records_both_feeds_and_ticks_the_live_cadences(db_session, seeded, monkeypatch):
    ticked = []
    monkeypatch.setattr(refresh_15m, "tick", lambda session, *, now, live_cadences: ticked.append(live_cadences))

    result = refresh_15m.run(db_session, scanning(FakeBarsSource()), now=TEN)
    db_session.commit()

    assert result.ok is True
    assert ticked == [refresh_15m._LIVE_CADENCES]
    assert (health(db_session, "bars_delayed").state, health(db_session, "scan").state) == ("ok", "ok")


def test_the_15_minute_job_still_ticks_when_the_provider_is_down(db_session, watchlist_with_items, monkeypatch):
    ticked = []
    monkeypatch.setattr(refresh_15m, "tick", lambda session, *, now, live_cadences: ticked.append(now))

    result = refresh_15m.run(db_session, WatchlistOnly(DownBars(FakeBarsSource(), down={"*"})), now=TEN)
    db_session.commit()

    assert result.ok is True  # the staleness guard, not an error, keeps alerts quiet
    assert ticked == [TEN]
    assert health(db_session, "bars_delayed").state == "down"


def test_the_daily_close_job_runs_the_daily_filters_with_a_scan_source(db_session, seeded, monkeypatch):
    monkeypatch.setattr(daily_close, "tick", lambda session, *, now, live_cadences: None)
    clock = JobClock()
    sources = scanning(FakeBarsSource())
    premarket.run(db_session, clock, now=PREMARKET, data_sources=sources)
    db_session.commit()

    result = daily_close.run(db_session, sources, clock, now=CLOSE_PASS)
    db_session.commit()

    assert result.ok is True
    assert health(db_session, "scan").last_ok_at == CLOSE_PASS
    assert filter_runs(db_session, "daily_close") > 0


def test_next_due_is_the_next_quarter_hour_inside_the_window():
    assert refresh_15m.next_due(datetime(2026, 10, 6, 14, 7, tzinfo=UTC)) == datetime(2026, 10, 6, 14, 15, tzinfo=UTC)
    assert refresh_15m.next_due(TEN) == TEN_FIFTEEN  # strictly after now
    assert refresh_15m.next_due(datetime(2026, 10, 6, 14, 7, 30, tzinfo=UTC)).second == 0


def test_next_due_skips_the_evening_the_weekend_and_a_holiday():
    tuesday_close = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)  # 17:00 ET, the last slot
    assert refresh_15m.next_due(tuesday_close) == datetime(2026, 10, 7, 11, 0, tzinfo=UTC)  # Wednesday 07:00 ET
    friday_close = datetime(2026, 10, 9, 21, 0, tzinfo=UTC)
    assert refresh_15m.next_due(friday_close) == datetime(2026, 10, 12, 11, 0, tzinfo=UTC)  # Monday 07:00 ET
    day_before_thanksgiving = datetime(2026, 11, 25, 22, 0, tzinfo=UTC)
    assert refresh_15m.next_due(day_before_thanksgiving) == datetime(2026, 11, 27, 12, 0, tzinfo=UTC)  # Fri 07:00 EST
