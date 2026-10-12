"""`degraded.quality_for`/`is_degraded` (PROTO-BRIEF.md section 4 L2): no IBKR in Phase 3 (D-c)
means a `bar_close_*` cadence can never reach "realtime"."""

import pytest

from ai_trading.engine.degraded import is_degraded, quality_for


@pytest.mark.parametrize(
    "asset,run_on,expected",
    [
        ("stock", "bar_close_1m", "delayed-15m"),
        ("stock", "bar_close_5m", "delayed-15m"),
        ("stock", "bar_close_15m", "delayed-15m"),
        ("stock", "bar_close_1h", "delayed-15m"),
        ("future", "bar_close_1m", "unavailable"),
        ("future", "bar_close_5m", "unavailable"),
        ("future", "bar_close_15m", "unavailable"),
        ("future", "bar_close_1h", "unavailable"),
        ("stock", "premarket_0830", "eod"),
        ("future", "premarket_0830", "eod"),
        ("stock", "daily_close", "eod"),
        ("future", "daily_close", "eod"),
        ("stock", "weekly", "eod"),
        ("future", "weekly", "eod"),
    ],
)
def test_quality_for_boundary_table(asset, run_on, expected):
    assert quality_for(asset, run_on) == expected


@pytest.mark.parametrize(
    "quality,expected",
    [
        ("realtime", False),
        ("eod", False),
        ("delayed-15m", True),
        ("fallback", True),
        ("unavailable", True),
    ],
)
def test_is_degraded_boundary_table(quality, expected):
    assert is_degraded(quality) == expected
