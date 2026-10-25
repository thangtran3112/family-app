"""Plain value types shared by the replay modules (no I/O, no database)."""

from dataclasses import dataclass, field
from typing import Literal

import pandas as pd

MarkKind = Literal["long_entry", "short_entry", "long_exit", "short_exit", "stop", "note"]
ENTRY_KINDS = ("long_entry", "short_entry")
EXIT_KINDS = ("long_exit", "short_exit")
INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15}


@dataclass(frozen=True)
class Mark:
    """A practice mark as stored. `at` is the playhead when it was placed; `price` the last print at or before it."""

    seq: int
    kind: MarkKind
    at: pd.Timestamp
    price: float | None
    shares: int | None = None
    stop_price: float | None = None
    note: str | None = None
    trade_no: int | None = None
    source: Literal["her", "auto"] = "her"
    id: int | None = None


@dataclass(frozen=True)
class Fire:
    """A would-fire signal: an armed strategy's rule turned true at the bar that closed at `bar_close`."""

    source: Literal["alert_strategy", "filter"]
    id: int
    name: str
    bias: str | None
    bar_time: pd.Timestamp
    bar_close: pd.Timestamp
    close: float
    evidence: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Plan:
    """The plan fields of a `ReplaySessionV1` that the journal scores."""

    stop_required: bool = False
    signal_only: bool = False
    max_loss_usd: int | None = None
    max_trades: int | None = None

    @property
    def any(self) -> bool:
        return self.stop_required or self.signal_only or self.max_loss_usd is not None or self.max_trades is not None
