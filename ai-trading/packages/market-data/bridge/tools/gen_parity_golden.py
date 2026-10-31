"""Generate the Go/Python parity golden for the Alpaca bar adapters (02u §6.2 T1).

The bridge's Go adapter and `ai_trading_common.providers.alpaca.AlpacaBars` are two implementations
of the same vendor contract -- the drift that produced 5U. This script runs the recorded fixtures
through the **Python** adapter and freezes its normalized answer, then `recorded_test.go` runs the
same cases through the **Go** adapter and asserts the two agree field for field: session date,
start, close instant, OHLCV, closed filtering, and the as_of cut.

Cross-language invocation is not a pattern in this repo, so the Python answer is committed as data
(a golden), the way 02u T1 prescribes.

Run (from the bridge directory, with the Desk backend checked out beside it):

    uv run --with pandas,exchange_calendars,python-dateutil,requests \\
        python tools/gen_parity_golden.py --common-src ../../../common/src \\
        --desk-src ../../family-desk/backend/src
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

BRIDGE = Path(__file__).resolve().parent.parent
ET = ZoneInfo("America/New_York")
OUT = BRIDGE / "testdata" / "vendor" / "alpaca" / "expected_python_bars.json"

#: Every case: the same fixture window the Go test replays. `as_of` is the bridge server's
#: no-look-ahead cut (read_bars semantics); None means "now".
CASES = [
    # 2026-10-26..2026-10-30 is the last week in daylight time: the 5U window, on real data.
    ("spy_daily_five_sessions", "testdata/vendor/alpaca/2026-10/daily_spy.json", "SPY", "1d",
     "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", None),
    ("spy_daily_one_session_5u", "testdata/vendor/alpaca/2026-10/daily_spy.json", "SPY", "1d",
     "2026-10-30T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", None),
    ("aapl_daily_five_sessions", "testdata/vendor/alpaca/2026-10/daily_aapl.json", "AAPL", "1d",
     "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", None),
    ("qqq_daily_five_sessions", "testdata/vendor/alpaca/2026-10/daily_qqq.json", "QQQ", "1d",
     "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", None),
    ("spy_daily_october", "testdata/vendor/alpaca/2026-10/daily_spy.json", "SPY", "1d",
     "2026-10-01T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", None),
    # as_of at 15:00 ET on the last day: that day's bar has not closed, so it is absent.
    ("spy_daily_as_of_mid_session", "testdata/vendor/alpaca/2026-10/daily_spy.json", "SPY", "1d",
     "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", "2026-10-30T19:00:00Z"),
    # as_of at 16:00 ET: the bar is in.
    ("spy_daily_as_of_close", "testdata/vendor/alpaca/2026-10/daily_spy.json", "SPY", "1d",
     "2026-10-26T08:00:00Z", "2026-10-31T00:00:00Z", "2026-10-31T15:00:00Z", "all", "2026-10-30T20:00:00Z"),
    ("spy_minute_close_window", "testdata/vendor/alpaca/2026-10/minute_spy_2026-10-30.json", "SPY", "1m",
     "2026-10-30T19:50:00Z", "2026-10-30T20:10:00Z", "2026-10-31T15:00:00Z", "all", None),
    ("aapl_minute_mid_session", "testdata/vendor/alpaca/2026-10/minute_aapl_2026-10-30.json", "AAPL", "1m",
     "2026-10-30T13:25:00Z", "2026-10-30T13:40:00Z", "2026-10-31T15:00:00Z", "all", None),
    # January: standard time, so a daily bar is stamped 05:00Z. Read from the common fixture set
    # by relative path, with no copy (02u T1).
    ("spy_daily_est_one_session", "../../../common/tests/fixtures/alpaca/daily_range_spy.json", "SPY", "1d",
     "2026-01-02T09:00:00Z", "2026-01-03T01:00:00Z", "2026-01-15T12:00:00Z", "all", None),
    ("spy_daily_est_january", "../../../common/tests/fixtures/alpaca/daily_range_spy.json", "SPY", "1d",
     "2026-01-02T09:00:00Z", "2026-01-15T00:00:00Z", "2026-01-15T12:00:00Z", "all", None),
    # A real 10:1 split (2024-06-10): RAW and SPLIT must give the same session dates and different
    # prices, and the adapter must not care.
    ("nvda_daily_raw_around_split", "testdata/vendor/alpaca/2024-06/daily_nvda_raw.json", "NVDA", "1d",
     "2024-06-05T08:00:00Z", "2024-06-13T00:00:00Z", "2026-10-31T15:00:00Z", "raw", None),
    ("nvda_daily_split_around_split", "testdata/vendor/alpaca/2024-06/daily_nvda_split.json", "NVDA", "1d",
     "2024-06-05T08:00:00Z", "2024-06-13T00:00:00Z", "2026-10-31T15:00:00Z", "split", None),
]


def load_desk(desk_src: Path):
    path = desk_src / "ai_trading" / "core" / "calendar.py"
    spec = importlib.util.spec_from_file_location("_desk_calendar", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Windowed:
    """Alpaca's server-side window over a recorded body: `start <= t <= end`, both inclusive."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.requests: list[dict] = []

    def get(self, url, params=None, headers=None, timeout=None, **kwargs):  # noqa: ANN001, ARG002
        query = dict(params or {})
        self.requests.append(query)
        start, end = pd.Timestamp(query["start"]), pd.Timestamp(query["end"])
        bars = [r for r in self.rows if start <= pd.Timestamp(r["t"]) <= end]
        return _Response({"bars": bars, "next_page_token": None})


class _Response:
    def __init__(self, body: dict) -> None:
        self.status_code = 200
        self._body = body

    def json(self) -> dict:
        return self._body


def bar_close(desk, timeframe: str, point) -> pd.Timestamp:
    """`ai_trading.data.bars.bar_close` for stocks, without importing the Desk package.

    `point` is a trading day for "1d" and a UTC bar start otherwise.
    """
    if timeframe == "1d":
        return desk.session("stock", pd.Timestamp(point).date()).regular_close
    if timeframe == "1m":
        return point + pd.Timedelta(minutes=1)
    natural = point + pd.Timedelta(hours=1)
    found = desk.session("stock", point.tz_convert(ET).date())
    if found is not None and found.regular_open <= point < found.regular_close:
        return min(natural, found.regular_close)
    return natural


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--common-src", required=True, type=Path)
    parser.add_argument("--desk-src", required=True, type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str((BRIDGE / args.common_src).resolve()))
    desk = load_desk((BRIDGE / args.desk_src).resolve())
    from ai_trading_common.providers.alpaca import AlpacaBars

    out_cases = []
    for name, fixture, symbol, timeframe, start, end, now, adjustment, as_of in CASES:
        body = json.loads((BRIDGE / fixture).read_text())["body"]
        session = Windowed(body.get("bars") or [])
        adapter = AlpacaBars("kid", "sec", http=session)
        got = adapter.bars(symbol, timeframe, pd.Timestamp(start), pd.Timestamp(end), now=pd.Timestamp(now), adjustment=adjustment)
        cutoff = pd.Timestamp(as_of) if as_of else pd.Timestamp(now)

        rows = []
        for point, row in got.frame.iterrows():
            if timeframe == "1d":
                session_day = point
                bar_start = pd.Timestamp(datetime.combine(session_day, datetime.min.time(), tzinfo=ET)).tz_convert("UTC")
            else:
                bar_start = pd.Timestamp(point)
                session_day = bar_start.tz_convert(ET).date()
            close_at = bar_close(desk, timeframe, bar_start if timeframe != "1d" else session_day)
            if pd.Timestamp(close_at) > cutoff:
                continue
            rows.append({
                "session_date": session_day.isoformat(),
                "start": bar_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row["volume"]),
                "close_at": pd.Timestamp(close_at).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
            })
        out_cases.append({
            "name": name,
            "fixture": str(fixture),
            "symbol": symbol,
            "timeframe": timeframe,
            "start": start,
            "end": end,
            "now": now,
            "adjustment": adjustment,
            "as_of": as_of,
            "quality": got.quality,
            "bars": rows,
        })
        print(f"{name}: {len(rows)} bars from {len(session.requests)} request(s)")

    OUT.write_text(json.dumps({
        "note": (
            "Generated by ai-trading/packages/market-data/bridge/tools/gen_parity_golden.py: the "
            "ai_trading_common Alpaca adapter's normalized answer for each recorded fixture, so the Go "
            "adapter can be proven identical (02u §6.2 T1). Do not hand-edit."
        ),
        "cases": out_cases,
    }, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()