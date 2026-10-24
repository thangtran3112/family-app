"""Trim the Run 0 snapshot (`temp/desk-desktop-mvp/snapshot-2026-10-23.json`, gitignored, 2 MB) to the
committed fixture `tests/fixtures/desk-mvp/snapshot_trimmed.json` (02m §a4).

    uv run python scripts/trim_desk_mvp_snapshot.py <path-to-snapshot.json>

What is kept: three symbols (SPY, NVDA, MSFT) with every timeframe's technicals and the last bars of
1d, 1h, 15m, 5m and the Friday extended-hours 5m; the shared metric rows for those symbols, every
watchlist and market-strip symbol, and every symbol in a kept screener match; the 15m bias label of
every symbol; each screener's header with its top matches; the replay fires (first five per
strategy); the pattern occurrences for the three symbols; the universe summary without the provider
payloads and the failure map. Nothing here is a provider payload.
"""

import json
import sys
from pathlib import Path

SYMBOLS = ("SPY", "NVDA", "MSFT")
BAR_ROWS = {"1d": 60, "1h": 40, "15m": 52, "5m": 78, "5m_extended_friday": 114}
TOP_MATCHES = 8
FIRES_KEPT = 5
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "desk-mvp" / "snapshot_trimmed.json"


def trim(snapshot: dict) -> dict:
    screeners = {}
    for key, screener in snapshot["screener"]["screeners"].items():
        kept = dict(screener)
        kept["matches"] = screener["matches"][:TOP_MATCHES]
        kept["matches_returned"] = len(kept["matches"])
        screeners[key] = kept
    lists = set(snapshot["market_strip"]) | set(snapshot["day_movers"]) | set(snapshot["swing"])
    wanted = set(SYMBOLS) | lists | {m["symbol"] for s in screeners.values() for m in s["matches"]}
    universe = snapshot["screener"]["universe"]
    replay = {}
    for key, entry in snapshot["alert_replay"].items():
        kept = dict(entry)
        kept["fires"] = entry["fires"][:FIRES_KEPT]
        replay[key] = kept
    return {
        "as_of": snapshot["as_of"],
        "generated_at_utc": snapshot["generated_at_utc"],
        "source": snapshot["source"],
        "market_strip": snapshot["market_strip"],
        "day_movers": snapshot["day_movers"],
        "swing": snapshot["swing"],
        # The 15m summary label for every snapshot symbol: the watchlist table's bias column.
        "bias_15m": {
            symbol: block["timeframes"]["15m"]["technicals"]["gauges"]["summary"]["label"]
            for symbol, block in snapshot["symbols"].items()
        },
        "symbols": {
            symbol: {
                "timeframes": snapshot["symbols"][symbol]["timeframes"],
                "bars": {
                    name: {**block, "rows": block["rows"][-BAR_ROWS[name] :]}
                    for name, block in snapshot["symbols"][symbol]["bars"].items()
                    if name in BAR_ROWS
                },
            }
            for symbol in SYMBOLS
        },
        "screener": {
            "universe": {
                "scan_basis": universe["scan_basis"],
                "candidates_after_symbol_filter": universe["candidates_after_symbol_filter"],
                "scanned": len(universe["passed_floor"]),
                "dropped_non_plain_tickers": universe["dropped_non_plain_tickers"],
                "no_daily_data": universe["no_daily_data"],
                "liquidity_floor": universe["liquidity_floor"],
            },
            "metrics": {s: m for s, m in snapshot["screener"]["metrics"].items() if s in wanted},
            "screeners": screeners,
        },
        "alert_replay": replay,
        "patterns": {
            "occurrences": [o for o in snapshot["patterns"]["occurrences"] if o["symbol"] in SYMBOLS],
        },
    }


def main() -> None:
    snapshot = json.loads(Path(sys.argv[1]).read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(trim(snapshot), separators=(",", ":"), sort_keys=True) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
