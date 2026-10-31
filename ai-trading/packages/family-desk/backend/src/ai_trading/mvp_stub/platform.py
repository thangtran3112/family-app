"""Stub builders for the platform family: `GET /status` (02m §a3.1) and `GET /dashboard` (02m §a3.2).

Plain dicts only; `api/status.py` and `api/dashboard.py` validate them against their response models.
"""

from typing import Any

from fastapi import HTTPException

from ai_trading.mvp_stub import SNAPSHOT_AS_OF, snapshot, stamp, unavailable_stamp, world

MARKET_STRIP_SYMBOLS = ("SPY", "QQQ", "IWM")
UNAVAILABLE_TILES = ("/ES", "/NQ")
SIGNALS_MAX = 20
TOP_MATCHES = 3


def status() -> dict[str, Any]:
    """The a3.1 example values, verbatim."""
    return {
        "market": {"session": "closed", "next_open": "2026-10-26T13:30:00Z", "last_close": SNAPSHOT_AS_OF},
        "quotes": stamp(freshness="closed"),
        "scans": {**stamp(freshness="delayed"), "next_run_at": "2026-10-26T12:30:00Z"},
        "alerts": {"state": "running", "unread": 2},
        "gateway": "not_configured",
        "gateway_reason": None,
        # One vendor per class (02t §5.5): the stub world is Alpaca everywhere.
        "data_sources": {
            "quotes": "alpaca",
            "bars": "alpaca",
            "option_chain": "alpaca_options",
            "trades": "alpaca",
            "universe": "alpaca",
        },
        "streaming_slots": {"used": 0, "max": 70},
        "backups": None,
        "reconciliation": None,
    }


def _market_tile(symbol: str) -> dict[str, Any]:
    metrics = world.metrics(symbol)
    return {"symbol": symbol, "last": metrics["last"], "change_pct": metrics["change_pct"], "stamp": stamp()}


def _screener_matches() -> list[dict[str, Any]]:
    screeners = snapshot()["screener"]["screeners"]
    out = []
    for item in world.filters():
        header = screeners[item["key"]]
        out.append(
            {
                "filter_id": item["id"],
                "name": item["name"],
                "run_on": item["run_on"],
                "scanned": header["scanned"],
                "matches_total": header["matches_total"],
                "top": [match["symbol"] for match in header["matches"][:TOP_MATCHES]],
                "stamp": stamp(),
            }
        )
    return out


def _watchlist_rows(symbols: list[str]) -> list[dict[str, Any]]:
    rows = []
    for symbol in symbols:
        metrics = world.metrics(symbol)
        rows.append(
            {
                "symbol": symbol,
                "last": metrics["last"],
                "change_pct": metrics["change_pct"],
                "rvol_10d": metrics["rvol_10d"],
                "vs_vwap_pct": metrics["vs_vwap_pct"],
                "bias_label": world.bias_label(symbol),
            }
        )
    return rows


def dashboard(watchlist_id: int) -> dict[str, Any]:
    lists = world.watchlists()
    if watchlist_id not in lists:
        raise HTTPException(status_code=404, detail="watchlist not found")
    chosen = lists[watchlist_id]
    watched = {symbol for entry in lists.values() for symbol in entry["symbols"]}
    signals = sorted(world.signals(), key=lambda signal: signal["bar_time"], reverse=True)[:SIGNALS_MAX]
    return {
        "stamp": stamp(),
        "market": {"session": "closed", "next_open": "2026-10-26T13:30:00Z"},
        "market_strip": [_market_tile(symbol) for symbol in MARKET_STRIP_SYMBOLS]
        + [
            {"symbol": symbol, "last": None, "change_pct": None, "stamp": unavailable_stamp()}
            for symbol in UNAVAILABLE_TILES
        ],
        "signals": signals,
        "screener_matches": _screener_matches(),
        "watchlist": {
            "id": chosen["id"],
            "name": chosen["name"],
            "rows": _watchlist_rows(chosen["symbols"]),
        },
        "events": [event for event in world.EVENTS if event["symbol"] in watched],
        "alerts_state": "running",
    }
