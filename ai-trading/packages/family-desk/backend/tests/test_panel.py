"""The technicals last-value panels (02m §a3.3): the indicator map against the Run 0 snapshot's recorded cell,
the bias history window and change, and the key levels."""

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ai_trading.core import bias, panel

FIXTURES = Path(__file__).parent / "fixtures" / "desk-mvp"


def _snapshot_daily(symbol: str) -> pd.DataFrame:
    rows = json.loads((FIXTURES / "snapshot_trimmed.json").read_text())["symbols"][symbol]["bars"]["1d"]["rows"]
    return pd.DataFrame(
        [row[1:] for row in rows],
        columns=["open", "high", "low", "close", "volume"],
        index=[date.fromisoformat(row[0]) for row in rows],
    )


def test_indicator_panel_keys_and_the_values_that_do_not_depend_on_history_length():
    recorded = json.loads((FIXTURES / "snapshot_trimmed.json").read_text())["symbols"]["SPY"]["timeframes"]["1d"]
    got = panel.indicator_panel(_snapshot_daily("SPY"))
    assert set(got) == set(recorded["indicators"])
    # The fixture keeps 60 daily bars where the snapshot read 311: windowed averages up to 50 bars are exact,
    # the longer ones are not known yet, and recursive ones only agree to a close tolerance.
    for key in ("sma_5", "sma_10", "sma_20", "sma_50"):
        assert got[key] == recorded["indicators"][key], key
    assert got["sma_100"] is None and got["sma_200"] is None and got["ema_200"] is None
    assert got["ema_5"] == pytest.approx(recorded["indicators"]["ema_5"], abs=0.05)
    assert got["rsi_14"] == pytest.approx(recorded["indicators"]["rsi_14"], abs=0.6)
    assert got["atr_14"] == pytest.approx(recorded["indicators"]["atr_14"], rel=0.02)
    assert got["atr_label"] is None  # the label needs 100 bars of ATR percent
    assert all(not isinstance(v, float) or np.isfinite(v) for v in got.values())


def _trending(count: int) -> pd.DataFrame:
    close = 100.0 + np.cumsum(np.sin(np.arange(count) / 5.0) + 0.05)
    return pd.DataFrame(
        {"open": close - 0.1, "high": close + 0.5, "low": close - 0.5, "close": close, "volume": 1e6},
        index=pd.date_range("2026-01-02 14:30", periods=count, freq="15min", tz="UTC"),
    )


def test_bias_history_is_the_last_twenty_bars_oldest_first_with_the_newest_change():
    frame = _trending(bias.MIN_BARS + 60)
    points, change = panel.bias_history(frame)
    assert len(points) == 20
    assert [p.bar for p in points] == list(frame.index[-20:])
    assert points[-1].summary == bias.bias(frame).summary_label
    labels = [p.summary for p in points]
    changes = [(a, b) for a, b in zip(labels, labels[1:], strict=False) if a != b]
    if changes:
        assert (change.from_label, change.to_label) == changes[-1]
    else:
        assert change is None


def test_bias_history_skips_warming_up_bars_and_is_empty_before_the_minimum():
    frame = _trending(bias.MIN_BARS + 5)
    points, _ = panel.bias_history(frame)
    assert len(points) == 6  # only bars 250..255 have a bias
    assert panel.bias_history(_trending(bias.MIN_BARS - 1)) == ([], None)


def test_session_levels_for_an_intraday_frame_span_the_last_day():
    index = pd.DatetimeIndex(
        [
            "2026-10-05 19:45:00+00:00",  # 15:45 ET Monday
            "2026-10-06 13:30:00+00:00",  # 09:30 ET Tuesday
            "2026-10-06 13:45:00+00:00",
            "2026-10-06 14:00:00+00:00",
        ]
    )
    frame = pd.DataFrame(
        {
            "open": 1.0,
            "high": [10.0, 11.0, 15.0, 12.0],
            "low": [9.0, 8.0, 7.0, 9.5],
            "close": [9.5, 10.0, 11.0, 12.0],
            "volume": 1.0,
        },
        index=index,
    )
    levels = panel.session_levels(frame)
    assert (levels.prior_close, levels.session_high, levels.session_low) == (9.5, 15.0, 7.0)


def test_session_levels_for_a_daily_frame_and_degenerate_frames():
    daily = pd.DataFrame(
        {"open": 1.0, "high": [5.0, 7.0], "low": [3.0, 4.0], "close": [4.0, 6.0], "volume": 1.0},
        index=[date(2026, 10, 5), date(2026, 10, 6)],
    )
    levels = panel.session_levels(daily)
    assert (levels.prior_close, levels.session_high, levels.session_low) == (4.0, 7.0, 4.0)
    assert panel.session_levels(daily.iloc[:1]).prior_close is None
    empty = panel.session_levels(daily.iloc[0:0])
    assert (empty.prior_close, empty.session_high, empty.session_low) == (None, None, None)
    only_today = panel.session_levels(_trending(3))  # one day in the frame: nothing before it
    assert only_today.prior_close is None and only_today.session_high is not None
