"""Golden test: the detector reproduces the 299 real pattern occurrences the desktop-MVP snapshot found.

`fixtures/patterns/seed-day-2026-10-23.json` holds real regular-session OHLC for the 17 seed symbols
(Fri 2026-10-23 on 15-minute bars, the last 10 sessions on daily bars), each series with 10 lead-in
bars. For every one of the 20 pattern templates, running the detector with the template's own
trend rule over each series must find exactly the occurrences the snapshot recorded: no misses and
no extras, including the silent (pattern, symbol, timeframe) cells.
"""

import json
from collections import Counter
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import patterns

BACKEND = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((BACKEND / "tests" / "fixtures" / "patterns" / "seed-day-2026-10-23.json").read_text())
TEMPLATES = sorted((BACKEND.parent / "contracts" / "templates" / "patterns").glob("*.json"))
EXPECTED_TOTAL = 299


def _frame(key: str) -> tuple[pd.DataFrame, int]:
    series = FIXTURE["series"][key]
    rows = series["bars"]
    if key.endswith("|1d"):
        index = pd.Index([date.fromisoformat(row[0]) for row in rows])
    else:
        index = pd.DatetimeIndex([pd.Timestamp(row[0]) for row in rows])
    frame = pd.DataFrame([row[1:] for row in rows], columns=["open", "high", "low", "close"], index=index)
    return frame, series["windowStart"]


def _stamp(value) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ") if isinstance(value, pd.Timestamp) else value.isoformat()


def test_the_fixture_holds_the_snapshots_299_occurrences_for_all_20_templates():
    assert sum(len(found) for found in FIXTURE["expected"].values()) == EXPECTED_TOTAL
    assert len(TEMPLATES) == len(patterns.PATTERN_CANDLES) == 20
    assert set(FIXTURE["expected"]) <= {path.stem for path in TEMPLATES}


@pytest.mark.parametrize("path", TEMPLATES, ids=lambda path: path.stem)
def test_the_detector_finds_exactly_the_snapshot_occurrences(path: Path):
    condition = StrategySpecV1.model_validate_json(path.read_text()).model_dump(by_alias=True, exclude_none=True)[
        "when"
    ]
    found = []
    for key in FIXTURE["series"]:
        symbol, timeframe = key.split("|")
        frame, window_start = _frame(key)
        in_window = set(frame.index[window_start:])
        for occurrence in patterns.occurrences(
            frame,
            condition["pattern"],
            trend=condition.get("trend"),
            trend_bars=condition.get("trendBars", patterns.DEFAULT_TREND_BARS),
        ):
            if occurrence.bar_time in in_window:
                found.append({"symbol": symbol, "timeframe": timeframe, "barStart": _stamp(occurrence.bar_time)})
    found.sort(key=lambda row: (row["timeframe"], row["symbol"], row["barStart"]))
    assert found == FIXTURE["expected"].get(path.stem, [])


def test_the_snapshot_counts_by_pattern_and_timeframe():
    counts = Counter((name, row["timeframe"]) for name, rows in FIXTURE["expected"].items() for row in rows)
    assert counts[("inside-bar", "15m")] == 74
    assert counts[("doji", "15m")] == 36
    assert counts[("hammer", "15m")] == 5
    assert counts[("dragonfly-doji", "15m")] == 1
    assert sum(counts.values()) == EXPECTED_TOTAL


def test_pltr_hammer_at_10_15_on_the_15_minute_bars():
    """The snapshot's worked example: a hammer after a downtrend, completing on the 10:15 ET bar."""
    frame, _ = _frame("PLTR|15m")
    found = patterns.occurrences(frame, "hammer", trend="after_downtrend", trend_bars=5)
    [bar] = [o for o in found if o.bar_time == pd.Timestamp("2026-10-23T14:15:00Z")]
    assert bar.first_bar_time == bar.bar_time
    assert bar.evidence == pytest.approx(
        {
            "open": 194.7,
            "high": 194.81,
            "low": 193.23,
            "close": 194.38,
            "bodyPct": 20.253165,
            "upperWickPct": 6.962025,
            "lowerWickPct": 72.78481,
        }
    )
    assert not [o for o in patterns.occurrences(frame, "hammer", trend="after_uptrend") if o.bar_time == bar.bar_time]
