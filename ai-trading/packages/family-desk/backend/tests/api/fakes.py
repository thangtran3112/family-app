"""Network-free `DataSources` test double for `tests/api/*` -- no live network call anywhere in
this directory. Only `bars` is ever touched by L4's own code (`api/quotes.py`,
`jobs.backfill_watchlist`'s stub); the other eight `DataSources` fields are never called by
anything this lane built, so a bare sentinel stands in for them.
"""

import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.registry import DataSources

_EMPTY_FRAME = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])


class FakeBarsSource:
    """Returns whatever frame `frames_by_symbol` has for the requested symbol (empty otherwise,
    mirroring a provider with nothing new right now), and records every call."""

    def __init__(self, frames_by_symbol: dict[str, pd.DataFrame] | None = None) -> None:
        self.frames_by_symbol = frames_by_symbol or {}
        self.calls: list[str] = []

    def bars(self, symbol: str, timeframe: str, start, end, *, now) -> Bars:
        self.calls.append(symbol)
        frame = self.frames_by_symbol.get(symbol, _EMPTY_FRAME)
        return Bars(frame=frame, source="fake", quality="delayed-15m")


def one_bar_frame(close: float) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": [close], "high": [close], "low": [close], "close": [close], "volume": [10.0]},
        index=pd.DatetimeIndex([pd.Timestamp.now(tz="UTC")]),
    )


def fake_data_sources(bars: FakeBarsSource | None = None) -> DataSources:
    unused = object()  # every DataSources field L4 never calls
    return DataSources(
        bars=bars or FakeBarsSource(),
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=unused,
        earnings=unused,
        targets=unused,
        universe=unused,
        quotes=unused,
        trades=unused,
    )
