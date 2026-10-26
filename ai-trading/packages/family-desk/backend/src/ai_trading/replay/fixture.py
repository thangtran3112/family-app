"""The `DESK_REPLAY_STUB=1` data layer (02o §f step 3c): the replay services run unchanged, but `bars` and
`trades` answer from the trimmed R0 fixture (`tests/fixtures/desk-replay/`, real TSLA data for Fri 2026-09-25:
extended-hours 1-minute bars, 10 prior sessions, 300 daily bars, and the first 10 minutes of consolidated
prints after the 09:30 open). Any other symbol or day answers `NoData`, so the picker's "No trades for XYZ"
message appears. Off in every deployed environment (`tests/test_mvp_stub_flag.py`).

Three stand-in names (`STAND_INS`) replay TSLA's day at a fraction of its prices, so a daily list can hold several names
and the switch flow can be driven end to end. They are made up; none is on a seeded watchlist, so the notable-days
table never lists them.

Also the test double the replay tests build on: `fixture_sources(base)` swaps only `bars` and `trades`.
"""

import gzip
import json
import os
from dataclasses import replace
from datetime import date
from functools import cache
from pathlib import Path
from typing import Any, Literal

import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.errors import NoData
from ai_trading_common.registry import DataSources
from ai_trading_common.trades import Trades

STUB_FLAG = "DESK_REPLAY_STUB"
FIXTURE_DIR_VAR = "DESK_REPLAY_FIXTURE_DIR"
_REPO_FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "desk-replay"
SYMBOL = "TSLA"
DAY = date(2026, 9, 25)
#: Stand-in name -> the fraction of TSLA's prices it trades at (volumes are TSLA's).
STAND_INS = {"LRCX": 0.3, "PANW": 0.2, "XOM": 0.1}
_PRICES = ["open", "high", "low", "close"]


def stub_enabled() -> bool:
    return os.environ.get(STUB_FLAG) == "1"


def fixture_dir() -> Path:
    return Path(os.environ.get(FIXTURE_DIR_VAR) or _REPO_FIXTURES)


@cache
def _gz(name: str) -> dict[str, Any]:
    return json.loads(gzip.decompress((fixture_dir() / name).read_bytes()))


@cache
def notable_days() -> dict[str, Any]:
    return json.loads((fixture_dir() / "notable_days.json").read_text())


def _frame(rows: list[list[Any]]) -> pd.DataFrame:
    index = pd.DatetimeIndex(pd.to_datetime([r[0] for r in rows], utc=True))
    return pd.DataFrame(
        {
            "open": [float(r[1]) for r in rows],
            "high": [float(r[2]) for r in rows],
            "low": [float(r[3]) for r in rows],
            "close": [float(r[4]) for r in rows],
            "volume": [float(r[5]) for r in rows],
        },
        index=index,
    )


class FixtureBars:
    """`BarsSource` over the fixture day. Raw prices only (the replay always asks for `raw`)."""

    def bars(self, symbol, timeframe, start, end, *, now, adjustment="all") -> Bars:
        scale = 1.0 if symbol == SYMBOL else STAND_INS.get(symbol)
        if scale is None:
            raise NoData("fixture", f"the fixture holds {SYMBOL} only")
        data = _gz("day-tsla-2026-09-25.json.gz")
        if timeframe == "1d":
            rows = data["daily_300"]["rows"]
            frame = pd.DataFrame(
                {
                    "open": [r[1] for r in rows],
                    "high": [r[2] for r in rows],
                    "low": [r[3] for r in rows],
                    "close": [r[4] for r in rows],
                    "volume": [r[5] for r in rows],
                },
                index=pd.Index([date.fromisoformat(r[0]) for r in rows], dtype=object),
            )
            frame[_PRICES] = frame[_PRICES].astype(float) * scale
            return Bars(frame=frame, source="fixture", quality="eod")
        rows = [*data["prior_bars_1m"]["rows"], *data["bars_1m"]["rows"]]
        frame = _frame(rows)
        frame = frame[(frame.index >= start) & (frame.index <= end)]
        if frame.empty:
            raise NoData("fixture", "no bars in range")
        frame[_PRICES] = frame[_PRICES] * scale
        return Bars(frame=frame, source="fixture", quality="delayed-15m")


class FixtureTrades:
    """`TradesSource` over the fixture prints (first minutes after the open); later chunks are empty."""

    def trades(self, symbol, start, end, *, feed: Literal["sip", "iex"], now=None) -> Trades:
        empty = pd.DataFrame({"t": pd.DatetimeIndex([], tz="UTC"), "p": [], "s": [], "x": [], "c": []})
        scale = 1.0 if symbol == SYMBOL else STAND_INS.get(symbol)
        if scale is None or feed != "sip":
            return Trades(frame=empty, source="fixture", feed=feed)
        rows = _gz("prints-tsla-2026-09-25.json.gz")["rows"]
        t = pd.to_datetime([r[0] for r in rows], unit="us", utc=True)
        frame = pd.DataFrame(
            {
                "t": t,
                "p": [float(r[1]) * scale for r in rows],
                "s": [int(r[2]) for r in rows],
                "x": [r[3] for r in rows],
                "c": [r[4] for r in rows],
            }
        )
        frame = frame[(frame["t"] >= start) & (frame["t"] <= end)].reset_index(drop=True)
        return Trades(frame=frame, source="fixture", feed=feed)


def fixture_sources(base: DataSources) -> DataSources:
    return replace(base, bars=FixtureBars(), trades=FixtureTrades())
