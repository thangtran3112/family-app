"""The swing world of the E2E runtime (`swing_services.py`): the scripted symbols answer, TSLA stays on its fixture day,
everything else is `NoData`, and the services run on the frozen E2E clock. No database: the services are plain
objects."""

from datetime import UTC, date
from pathlib import Path

import pandas as pd
import pytest
from ai_trading_common.errors import NoData
from clock import E2E_NOW
from swing_services import E2EBars, replay_services
from swing_world import DAYS, FIRST_DAY, GAP_UP_DAY, SPLIT_DAY, SYMBOLS

from ai_trading.core.calendar import et
from ai_trading.replay import fixture
from ai_trading.replay.cache import MemoryBlobStore

SRC = Path(__file__).resolve().parents[2] / "src"


def _utc(value) -> pd.Timestamp:
    stamp = pd.Timestamp(value)
    return stamp.tz_convert("UTC") if stamp.tzinfo else stamp.tz_localize("UTC")


def _bars(symbol: str, timeframe: str, start, end, adjustment: str = "all"):
    return E2EBars().bars(symbol, timeframe, _utc(start), _utc(end), now=E2E_NOW, adjustment=adjustment)


def test_the_scripted_stocks_answer_with_their_gap_and_their_split() -> None:
    raw = _bars("S01", "1d", "2026-01-01", "2026-12-31", "raw").frame
    jump = raw.loc[GAP_UP_DAY, "open"] / raw.loc[DAYS[DAYS.index(GAP_UP_DAY) - 1], "close"]
    assert jump == pytest.approx(1.06, rel=1e-3)  # S01 gaps up 6% at the open of session 4
    s03 = _bars("S03", "1d", "2026-01-01", "2026-12-31", "raw").frame
    assert s03.loc[SPLIT_DAY, "close"] < s03.loc[DAYS[DAYS.index(SPLIT_DAY) - 1], "close"] * 0.6  # raw halves
    adjusted = _bars("S03", "1d", "2026-01-01", "2026-12-31", "split").frame
    assert adjusted.loc[SPLIT_DAY, "close"] == pytest.approx(
        adjusted.loc[DAYS[DAYS.index(SPLIT_DAY) - 1], "close"], rel=0.02
    )
    minutes = _bars("S04", "1m", et(FIRST_DAY, "04:00"), et(FIRST_DAY, "20:00")).frame
    assert len(minutes) > 900 and minutes.index.tz is not None


def test_spy_has_daily_bars_only_and_unknown_symbols_are_no_data() -> None:
    spy = _bars("SPY", "1d", "2026-01-01", "2026-12-31").frame
    assert len(spy) > 100 and spy["volume"].max() < 500_000  # under the live floor: a daily list never scans it in
    for symbol, timeframe in (("SPY", "1m"), ("ZZZZ", "1d"), ("AAPL", "1m")):
        with pytest.raises(NoData):
            _bars(symbol, timeframe, et(FIRST_DAY, "09:30"), et(FIRST_DAY, "16:00"))


def test_tsla_is_still_the_fixture_day() -> None:
    frame = _bars("TSLA", "1m", et(fixture.DAY, "09:30"), et(fixture.DAY, "10:30")).frame
    assert len(frame) > 0 and frame.index[0].tz_convert("America/New_York").date() == fixture.DAY


def test_the_services_run_on_the_frozen_clock_and_ask_no_calendar() -> None:
    from fakes import fake_data_sources  # on the path since `swing_services` was imported

    services = replay_services(fake_data_sources())
    assert services.now() == E2E_NOW and services.now().tzinfo == UTC
    assert services.sources is None  # no earnings calendar to ask
    store = MemoryBlobStore()
    frames = services.history.daily_bars(store, "S01", date(2026, 9, 21))
    assert len(frames) > 100
    assert {s for s in SYMBOLS} <= set(E2EBars().world.raw)


def test_no_deployed_code_imports_the_e2e_world() -> None:
    offenders = [
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if "swing_services" in path.read_text() or "swing_world" in path.read_text()
    ]
    assert offenders == []
