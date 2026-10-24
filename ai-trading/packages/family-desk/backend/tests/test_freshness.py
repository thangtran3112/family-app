"""`core/freshness.py`: every row of 02l §c3 as a table, plus the session and market-state helpers."""

from datetime import UTC, datetime, timedelta

import pytest

from ai_trading.core.freshness import freshness, market_session, market_state, pause_limit

NOW = datetime(2026, 10, 23, 15, 0, tzinfo=UTC)  # Fri 11:00 ET, regular session
MIN1 = timedelta(minutes=1)
MIN15 = timedelta(minutes=15)


def ago(seconds: float) -> datetime:
    return NOW - timedelta(seconds=seconds)


# (case, quality, session, last_ok_at, interval, expected)
ROWS = [
    ("live: realtime, fresh", "realtime", "regular", ago(2), MIN1, "live"),
    ("live: realtime, quiet but inside the pause limit", "realtime", "regular", ago(100), MIN1, "live"),
    ("live: pre-market realtime", "realtime", "pre", ago(2), MIN1, "live"),
    ("delayed: delayed SIP, in session", "delayed-15m", "regular", ago(60), MIN15, "delayed"),
    ("delayed: delayed SIP, after hours", "delayed-15m", "after", ago(60), MIN15, "delayed"),
    ("delayed: end-of-day data in session", "eod", "regular", ago(3600), timedelta(days=1), "delayed"),
    ("delayed: backup source is never live", "fallback", "regular", ago(2), MIN1, "delayed"),
    ("closed: realtime but market closed", "realtime", "closed", ago(2), MIN1, "closed"),
    ("closed: delayed data, market closed", "delayed-15m", "closed", ago(86400), MIN15, "closed"),
    ("paused: realtime older than 120 s on 1m", "realtime", "regular", ago(121), MIN1, "paused"),
    ("paused: delayed older than 2 x 15m", "delayed-15m", "regular", ago(1801), MIN15, "paused"),
    ("paused: backup source gone quiet", "fallback", "regular", ago(500), MIN1, "paused"),
    ("unavailable: provider chain failed", "unavailable", "regular", ago(2), MIN1, "unavailable"),
    ("unavailable: feed never worked", "delayed-15m", "regular", None, MIN15, "unavailable"),
    ("unavailable beats closed", "unavailable", "closed", ago(2), MIN1, "unavailable"),
    ("unavailable: never worked while closed", "realtime", "closed", None, MIN1, "unavailable"),
]


@pytest.mark.parametrize(
    ("case", "quality", "market", "last_ok", "interval", "expected"), ROWS, ids=[r[0] for r in ROWS]
)
def test_freshness_table(case, quality, market, last_ok, interval, expected) -> None:
    assert freshness(quality, market, last_ok, NOW, interval) == expected


def test_pause_limit_is_the_larger_of_120_seconds_and_two_intervals() -> None:
    assert pause_limit(MIN1) == timedelta(seconds=120)
    assert pause_limit(timedelta(seconds=30)) == timedelta(seconds=120)
    assert pause_limit(MIN15) == timedelta(minutes=30)


def test_pause_boundary_is_inclusive_of_the_limit() -> None:
    assert freshness("realtime", "regular", ago(120), NOW, MIN1) == "live"
    assert freshness("realtime", "regular", ago(120.1), NOW, MIN1) == "paused"


# Fri 2026-10-23 is a normal session (EDT: ET = UTC-4); Sat 10-24 closed; Mon 10-26 normal;
# Fri 2026-11-27 is the half day after Thanksgiving (closes 13:00 ET).
@pytest.mark.parametrize(
    ("moment", "expected"),
    [
        (datetime(2026, 10, 23, 7, 59, tzinfo=UTC), "closed"),  # 03:59 ET
        (datetime(2026, 10, 23, 8, 0, tzinfo=UTC), "pre"),  # 04:00 ET
        (datetime(2026, 10, 23, 13, 29, tzinfo=UTC), "pre"),  # 09:29 ET
        (datetime(2026, 10, 23, 13, 30, tzinfo=UTC), "regular"),  # 09:30 ET
        (datetime(2026, 10, 23, 19, 59, tzinfo=UTC), "regular"),  # 15:59 ET
        (datetime(2026, 10, 23, 20, 0, tzinfo=UTC), "after"),  # 16:00 ET
        (datetime(2026, 10, 24, 0, 0, tzinfo=UTC), "closed"),  # 20:00 ET, four hours past the close
        (datetime(2026, 10, 24, 15, 0, tzinfo=UTC), "closed"),  # Saturday
        (datetime(2026, 11, 26, 15, 0, tzinfo=UTC), "closed"),  # Thanksgiving
        (datetime(2026, 11, 27, 18, 30, tzinfo=UTC), "after"),  # half day: 13:30 ET, past the 13:00 close
    ],
)
def test_market_session(moment: datetime, expected: str) -> None:
    assert market_session(moment) == expected


def test_market_state_on_a_weekend_points_at_monday_open_and_friday_close() -> None:
    state = market_state(datetime(2026, 10, 24, 15, 0, tzinfo=UTC))
    assert state.session == "closed"
    assert state.next_open == datetime(2026, 10, 26, 13, 30, tzinfo=UTC)
    assert state.last_close == datetime(2026, 10, 23, 20, 0, tzinfo=UTC)


def test_market_state_mid_session_has_todays_open_behind_and_tomorrows_ahead() -> None:
    state = market_state(NOW)
    assert state.session == "regular"
    assert state.next_open == datetime(2026, 10, 26, 13, 30, tzinfo=UTC)
    assert state.last_close == datetime(2026, 10, 22, 20, 0, tzinfo=UTC)


def test_market_state_before_the_open_looks_forward_to_today() -> None:
    state = market_state(datetime(2026, 10, 23, 10, 0, tzinfo=UTC))  # 06:00 ET pre-market
    assert state.session == "pre"
    assert state.next_open == datetime(2026, 10, 23, 13, 30, tzinfo=UTC)
    assert state.last_close == datetime(2026, 10, 22, 20, 0, tzinfo=UTC)


def test_market_state_across_a_holiday_skips_it() -> None:
    state = market_state(datetime(2026, 11, 26, 15, 0, tzinfo=UTC))  # Thanksgiving
    assert state.next_open == datetime(2026, 11, 27, 14, 30, tzinfo=UTC)
    assert state.last_close == datetime(2026, 11, 25, 21, 0, tzinfo=UTC)  # after EST switch: 16:00 ET = 21:00Z
