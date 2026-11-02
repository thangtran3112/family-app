"""Loader for `contracts/fixtures/indicator-golden-v1/golden.json` (see `tests/make_indicator_golden.py`): real
Alpaca SIP TSLA bars and the reference values the indicators are pinned to. Shared by `test_indicator_golden.py`
and `api/test_indicator_golden_api.py`. Only high, low and close (and the minute volume) are real; `open` repeats
the close and the daily volume is a placeholder, because no indicator pinned here reads them."""

import json
from pathlib import Path

import pandas as pd

GOLDEN = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "indicator-golden-v1" / "golden.json").read_text()
)


def golden_daily() -> pd.DataFrame:
    frame = pd.DataFrame(GOLDEN["daily"]["rows"], columns=GOLDEN["daily"]["cols"])
    frame.index = pd.Index([pd.Timestamp(day).date() for day in frame.pop("day")])
    frame = frame.rename(columns={"h": "high", "l": "low", "c": "close"})
    frame["open"], frame["volume"] = frame["close"], 1_000_000.0
    return frame[["open", "high", "low", "close", "volume"]]


def golden_minutes() -> pd.DataFrame:
    frame = pd.DataFrame(GOLDEN["minutes"]["rows"], columns=GOLDEN["minutes"]["cols"])
    frame.index = pd.DatetimeIndex(pd.to_datetime(frame.pop("t"), utc=True))
    frame = frame.rename(columns={"h": "high", "l": "low", "c": "close", "v": "volume"})
    frame["open"] = frame["close"]
    return frame[["open", "high", "low", "close", "volume"]]
