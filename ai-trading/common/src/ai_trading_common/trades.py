"""Trade prints (the tape): the shared, vendor-neutral frame shape for one symbol's trades over a window.

Each row is one print: `t` (UTC print time), `p` (price), `s` (size), `x` (exchange code, "" when the provider
sent none), and `c` (the provider's condition codes joined with no separator, "" when none). A provider's adapter
maps its own records into this shape, the same way it maps bars into `Bars` (see `providers/alpaca.py`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pandas as pd

TRADE_COLUMNS = ("t", "p", "s", "x", "c")


@dataclass(frozen=True)
class Trades:
    """The prints for one symbol on one feed, sorted by print time. Unlike `Bars` there is no `quality` field,
    so `registry._relabel` leaves a fallback result unlabeled; `source` names the provider that answered."""

    frame: pd.DataFrame
    source: str
    feed: Literal["sip", "iex"]


def empty_trades_frame() -> pd.DataFrame:
    """A zero-row frame with the shared columns and dtypes (a window with no prints)."""
    return pd.DataFrame(
        {
            "t": pd.Series([], dtype="datetime64[ns, UTC]"),
            "p": pd.Series([], dtype="float64"),
            "s": pd.Series([], dtype="int64"),
            "x": pd.Series([], dtype=str),
            "c": pd.Series([], dtype=str),
        },
        columns=list(TRADE_COLUMNS),
    )
