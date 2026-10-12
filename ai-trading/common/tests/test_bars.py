from datetime import date

import pandas as pd
import pytest

from ai_trading_common.bars import BarValidationError, drop_unclosed, validate


def _ohlcv(closes):
    return {
        "open": closes,
        "high": [c + 1 for c in closes],
        "low": [c - 1 for c in closes],
        "close": closes,
        "volume": 100.0,
    }


def daily_frame(days, closes):
    return pd.DataFrame(_ohlcv(closes), index=pd.Index(days))


def intraday_frame(starts, closes):
    has_tz = isinstance(starts, pd.DatetimeIndex) and starts.tz is not None
    index = starts if has_tz else pd.DatetimeIndex(starts, tz="UTC")
    return pd.DataFrame(_ohlcv(closes), index=index)


class TestValidate:
    def test_drops_a_bad_row_but_keeps_the_rest(self):
        frame = daily_frame([date(2026, 1, 2), date(2026, 1, 5)], [10.0, 20.0])
        frame.loc[date(2026, 1, 2), "high"] = 5.0  # high < low
        out = validate(frame, "1d")
        assert list(out.index) == [date(2026, 1, 5)]

    def test_drops_a_non_positive_price(self):
        frame = daily_frame([date(2026, 1, 2)], [0.0])
        assert validate(frame, "1d").empty

    def test_sorts_and_dedupes_the_index(self):
        frame = daily_frame([date(2026, 1, 5), date(2026, 1, 2), date(2026, 1, 2)], [20.0, 9.0, 10.0])
        out = validate(frame, "1d")
        assert list(out.index) == [date(2026, 1, 2), date(2026, 1, 5)]
        assert out.loc[date(2026, 1, 2), "close"] == 10.0  # last wins on a duplicate

    def test_rejects_missing_columns(self):
        with pytest.raises(BarValidationError):
            validate(pd.DataFrame({"open": [1.0]}, index=[date(2026, 1, 2)]), "1d")

    def test_rejects_daily_frame_with_timestamp_index(self):
        frame = pd.DataFrame(
            {"open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0], "volume": [1.0]},
            index=pd.DatetimeIndex(["2026-01-02"], tz="UTC"),
        )
        with pytest.raises(BarValidationError):
            validate(frame, "1d")

    def test_intraday_frame_converted_to_utc(self):
        starts = pd.date_range("2026-01-02 14:30", periods=2, freq="1h", tz="America/New_York")
        frame = intraday_frame(starts, [1.0, 2.0])
        out = validate(frame, "1h")
        assert str(out.index.tz) == "UTC"


class TestDropUnclosed:
    def test_1m_keeps_only_bars_closed_by_now(self):
        starts = pd.date_range("2026-01-02 14:30", periods=3, freq="1min", tz="UTC")
        frame = intraday_frame(starts, [1.0, 2.0, 3.0])
        now = starts[1] + pd.Timedelta(minutes=1)  # the second bar has just closed
        out = drop_unclosed(frame, "1m", now)
        assert list(out.index) == list(starts[:2])

    def test_1h_caps_the_last_bin_at_the_session_close(self):
        # XNYS regular close on 2026-03-09 (post-DST) is 16:00 ET = 20:00 UTC.
        # A 1h bar starting 15:30 ET would normally run to 16:30 ET, but the
        # session ends at 16:00 ET, so it closes 30 minutes early.
        start = pd.Timestamp("2026-03-09 15:30", tz="America/New_York").tz_convert("UTC")
        frame = intraday_frame([start], [1.0])
        before_session_close = start + pd.Timedelta(minutes=20)
        after_session_close = start + pd.Timedelta(minutes=35)
        assert drop_unclosed(frame, "1h", before_session_close).empty
        assert not drop_unclosed(frame, "1h", after_session_close).empty

    def test_1h_post_close_extended_hours_bar_still_needs_its_own_60_minutes(self):
        # A real Alpaca half-day fixture (2025-11-28, 13:00 ET close) includes an
        # hourly bar starting at 16:00 ET = 21:00 UTC, in the post-market session.
        # It must not be capped at the already-past 13:00 ET regular close, which
        # would mark it "closed" the instant it starts.
        start = pd.Timestamp("2025-11-28 21:00", tz="UTC")
        frame = intraday_frame([start], [1.0])
        assert drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=30)).empty
        assert not drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=61)).empty

    def test_1h_half_day_closes_at_13_00_et(self):
        # 2025-11-28 (day after Thanksgiving) is a half day: close 13:00 ET = 18:00 UTC.
        start = pd.Timestamp("2025-11-28 12:30", tz="America/New_York").tz_convert("UTC")
        frame = intraday_frame([start], [1.0])
        assert drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=20)).empty
        assert not drop_unclosed(frame, "1h", start + pd.Timedelta(minutes=35)).empty

    def test_1d_half_day_closes_at_13_00_et(self):
        frame = daily_frame([date(2025, 11, 28)], [10.0])
        before_close = pd.Timestamp("2025-11-28 12:59", tz="America/New_York").tz_convert("UTC")
        after_close = pd.Timestamp("2025-11-28 13:00", tz="America/New_York").tz_convert("UTC")
        assert drop_unclosed(frame, "1d", before_close).empty
        assert not drop_unclosed(frame, "1d", after_close).empty

    def test_1d_drops_a_non_trading_day(self):
        frame = daily_frame([date(2026, 3, 7)], [10.0])  # a Saturday
        assert drop_unclosed(frame, "1d", pd.Timestamp("2030-01-01", tz="UTC")).empty

    def test_requires_tz_aware_now(self):
        frame = daily_frame([date(2026, 1, 2)], [10.0])
        with pytest.raises(BarValidationError):
            drop_unclosed(frame, "1d", pd.Timestamp("2026-01-05"))
