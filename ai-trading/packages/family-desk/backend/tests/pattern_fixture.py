"""The recorded pattern day (`fixtures/patterns/seed-day-2026-10-23.json`) as bars the stores and the evaluator read.

The fixture holds regular-session OHLC for 17 symbols: Fri 2026-10-23 on 15-minute candles and the last
sessions on daily candles, each with lead-in bars, plus the snapshot's 299 pattern occurrences keyed by template.
"""

import json
from datetime import date
from pathlib import Path

import pandas as pd

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "patterns" / "seed-day-2026-10-23.json").read_text())
SYMBOLS = sorted({key.split("|")[0] for key in FIXTURE["series"]})
DAY = date(2026, 10, 23)
VOLUME = 1_000_000.0


def daily(symbol: str) -> pd.DataFrame:
    """The symbol's daily candles, indexed by trading day."""
    rows = FIXTURE["series"][f"{symbol}|1d"]["bars"]
    return pd.DataFrame(
        [[*row[1:], VOLUME] for row in rows],
        columns=["open", "high", "low", "close", "volume"],
        index=pd.Index([date.fromisoformat(row[0]) for row in rows]),
    )


def minutes(symbol: str) -> pd.DataFrame:
    """1-minute bars that resample to the symbol's recorded 15-minute candles: each candle becomes 15 minutes
    that open at its open, touch its high and its low, and close at its close."""
    frames = []
    for start, o, h, low, c in FIXTURE["series"][f"{symbol}|15m"]["bars"]:
        shape = [(o, o, o, o), (o, h, o, o), (o, o, low, o)] + [(o, o, o, o)] * 11 + [(c, c, c, c)]
        index = pd.date_range(pd.Timestamp(start), periods=15, freq="1min")
        frames.append(pd.DataFrame(shape, columns=["open", "high", "low", "close"], index=index))
    out = pd.concat(frames)
    out["volume"] = 100.0
    return out


def occurrences(template: str, symbol: str, timeframe: str) -> list[str]:
    """The snapshot's bar starts for one pattern template, symbol and timeframe, oldest first."""
    return sorted(
        row["barStart"]
        for row in FIXTURE["expected"].get(template, [])
        if row["symbol"] == symbol and row["timeframe"] == timeframe
    )
