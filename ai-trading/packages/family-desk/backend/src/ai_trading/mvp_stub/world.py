"""The stub's one self-consistent world: ids, names, and strategies every family agrees on. The ids
are what a freshly seeded database would hold for the first user (`cli/seed_technical.py`: two
watchlists, ten filters in catalog order, five seed alert strategies), so the frontend's stub runs
and its seeded end-to-end runs line up. Strategies 6 and 7 are extras for the states a seed does not
show (active and paused)."""

from functools import cache
from typing import Any

from ai_trading.cli.seed_technical import SEED_WATCHLISTS, seed_alert_specs
from ai_trading.library.catalog import alert_only_spec, load_catalog, load_template
from ai_trading.mvp_stub import et_to_utc, snapshot

SYMBOL_NAMES = {
    "SPY": "SPDR S&P 500 ETF",
    "QQQ": "Invesco QQQ Trust",
    "IWM": "iShares Russell 2000 ETF",
    "NVDA": "NVIDIA Corp",
    "AMD": "Advanced Micro Devices",
    "TSLA": "Tesla Inc",
    "PLTR": "Palantir Technologies",
    "META": "Meta Platforms",
    "AAPL": "Apple Inc",
    "AVGO": "Broadcom Inc",
    "COIN": "Coinbase Global",
    "MSFT": "Microsoft Corp",
    "AMZN": "Amazon.com Inc",
    "GOOGL": "Alphabet Inc Class A",
    "CRWD": "CrowdStrike Holdings",
    "SHOP": "Shopify Inc",
    "UBER": "Uber Technologies",
}
ETFS = {"SPY", "QQQ", "IWM"}

#: Earnings dates for symbols on her lists (02j `earnings_calendar`; earnings dates only).
EVENTS = [
    {"symbol": "MSFT", "kind": "earnings", "date": "2026-10-28", "timing": "after_close"},
    {"symbol": "GOOGL", "kind": "earnings", "date": "2026-10-28", "timing": "after_close"},
    {"symbol": "META", "kind": "earnings", "date": "2026-10-29", "timing": "after_close"},
    {"symbol": "AAPL", "kind": "earnings", "date": "2026-10-29", "timing": "after_close"},
    {"symbol": "AMZN", "kind": "earnings", "date": "2026-10-29", "timing": "after_close"},
]


def asset_type(symbol: str) -> str:
    return "etf" if symbol in ETFS else "stock"


def watchlists() -> dict[int, dict[str, Any]]:
    return {
        index: {"id": index, "name": name, "horizon": horizon, "symbols": list(symbols)}
        for index, (name, horizon, symbols) in enumerate(SEED_WATCHLISTS, start=1)
    }


@cache
def filters() -> list[dict[str, Any]]:
    """The ten seed filters, id 1..10 in catalog order. `key` is also the snapshot's screener key."""
    out = []
    for entry in (e for e in load_catalog().entries if e.kind == "filter"):
        template = load_template(entry.file)
        out.append(
            {
                "id": len(out) + 1,
                "key": entry.id,
                "name": template["name"],
                "run_on": template["watch"]["runOn"],
                "session": template["watch"]["session"],
                "summary": entry.summary,
            }
        )
    return out


def _alert_row(
    row_id: int, spec: Any, *, stage: str, origin: str, replay_key: str | None, paused: str | None = None
) -> dict[str, Any]:
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    alert = dumped["then"]["alert"]
    return {
        "id": row_id,
        "name": spec.name,
        "origin": origin,
        "stage": stage,
        "paused_reason": paused,
        "version": 1,
        "run_on": dumped["watch"]["runOn"],
        "frequency": alert.get("frequency", "once_per_bar"),
        "cooldown_minutes": dumped.get("limits", {}).get("cooldownMinutes"),
        "expires_on": alert.get("expiresOn"),
        "channels": alert["channels"],
        "severity": alert.get("severity", "info"),
        "replay_key": replay_key,
        "spec": dumped,
    }


@cache
def alert_strategies() -> list[dict[str, Any]]:
    seeds = seed_alert_specs()
    # Stage and replay data per seed: ORB 15m, VWAP reclaim, Hammer 15m near S1, Abnormal volume, HOD break.
    rows = [
        _alert_row(1, seeds[0], stage="draft", origin="seed", replay_key="orb-breakout"),
        _alert_row(2, seeds[1], stage="alert_only", origin="seed", replay_key="vwap-reclaim"),
        _alert_row(3, seeds[2], stage="draft", origin="seed", replay_key=None),
        _alert_row(4, seeds[3], stage="draft", origin="seed", replay_key=None),
        _alert_row(5, seeds[4], stage="draft", origin="seed", replay_key="setups/hod-break"),
        _alert_row(
            6,
            alert_only_spec(load_template("setups/ema-9-21-cross.json"), name="EMA 9/21 cross", watchlist="Day movers"),
            stage="alert_only",
            origin="library",
            replay_key="setups/ema-9-21-cross",
        ),
        _alert_row(
            7,
            alert_only_spec(load_template("vwap-loss.json"), name="VWAP loss", watchlist="Swing"),
            stage="alert_only",
            origin="library",
            replay_key="vwap-loss",
            paused="user",
        ),
    ]
    return rows


def replay_fires(replay_key: str | None) -> list[dict[str, Any]]:
    """Snapshot replay fires for a strategy: `{symbol, bar_time, evidence}` with UTC `Z` times."""
    if replay_key is None:
        return []
    entry = snapshot()["alert_replay"].get(replay_key, {})
    return [
        {"symbol": f["symbol"], "bar_time": et_to_utc(f["bar_start_et"]), "evidence": f["evidence"]}
        for f in entry.get("fires", [])
    ]


_METRIC_KEYS = (
    "last",
    "prev_close",
    "change_pct",
    "volume",
    "avg_volume_20d",
    "rvol_10d",
    "atr_pct_14",
    "rsi_14",
    "gap_pct_open",
    "high_252d",
    "dist_to_252d_high_pct",
    "vwap_close",
    "vs_vwap_pct",
    "rvol_intraday_10d_at_close",
)


def metrics(symbol: str) -> dict[str, float | None]:
    """The shared metric row for `symbol` from the snapshot, all keys present, null when unknown."""
    row = snapshot()["screener"]["metrics"].get(symbol, {})
    return {key: row.get(key) for key in _METRIC_KEYS}


def bias_label(symbol: str) -> str:
    """The 15m summary label (the default technical view), or "warming up" for an unknown symbol."""
    return snapshot().get("bias_15m", {}).get(symbol, "warming up")


_KIND_BY_NAME = {
    "ORB 15m": "orb",
    "VWAP reclaim": "vwap_reclaim",
    "Hammer 15m near S1": "pattern",
    "Abnormal volume": "rvol",
}


def strategy_kind(name: str) -> str:
    return _KIND_BY_NAME.get(name, "other")


@cache
def signals() -> list[dict[str, Any]]:
    """Today's-style signals from the replay fires of every alert-only strategy, id 1..n by bar time.
    Each row: `id, symbol, strategy_id, strategy_name, kind, bar_time (UTC Z), summary, evidence`."""
    fires = [
        (fire["bar_time"], strategy, fire)
        for strategy in alert_strategies()
        if strategy["stage"] == "alert_only"
        for fire in replay_fires(strategy["replay_key"])
    ]
    fires.sort(key=lambda item: (item[0], item[1]["id"], item[2]["symbol"]))
    return [
        {
            "id": index,
            "symbol": fire["symbol"],
            "strategy_id": strategy["id"],
            "strategy_name": strategy["name"],
            "kind": strategy_kind(strategy["name"]),
            "bar_time": bar_time,
            "summary": f"{strategy['name']} on {fire['symbol']}",
            "evidence": fire["evidence"],
        }
        for index, (bar_time, strategy, fire) in enumerate(fires, start=1)
    ]


@cache
def inbox() -> list[dict[str, Any]]:
    """Inbox alerts, one per signal, id = signal id, newest last in the list. The two newest are unread
    (matching `/status.alerts.unread == 2`). Fields: `id, kind, severity, title, body, payload,
    created_at, read_at, symbol, strategy_id, strategy_name`; `read_at` is null when unread."""
    by_id = {s["id"]: s for s in alert_strategies()}
    rows = signals()
    out = []
    for position, signal in enumerate(rows):
        strategy = by_id[signal["strategy_id"]]
        unread = position >= len(rows) - 2
        out.append(
            {
                "id": signal["id"],
                "kind": "signal",
                "severity": strategy["severity"],
                "title": f"{signal['strategy_name']}: {signal['symbol']}",
                "body": " ".join(
                    part
                    for part in (
                        signal["symbol"],
                        str(signal["evidence"].get("close", "")),
                        f"at {signal['bar_time'][11:16]} UTC",
                    )
                    if part
                ),
                "payload": {"signal_id": signal["id"]},
                "created_at": signal["bar_time"],
                "read_at": None if unread else signal["bar_time"],
                "symbol": signal["symbol"],
                "strategy_id": signal["strategy_id"],
                "strategy_name": signal["strategy_name"],
            }
        )
    return out
