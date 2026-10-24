"""Stub values for the metric, bias, and tag columns of `GET /watchlists/{id}/table` (02m §a3.5). The
rows themselves still come from the database; only these columns come from the fixture."""

from typing import Any

from ai_trading.mvp_stub import world

TAG_LIMIT = 3


def table_fields(symbol: str, watchlist_name: str) -> dict[str, Any]:
    """The four metric columns, the bias label, and at most three tags for one row."""
    metrics = world.metrics(symbol)
    return {
        "last": metrics["last"],
        "change_pct": metrics["change_pct"],
        "rvol_10d": metrics["rvol_10d"],
        "vs_vwap_pct": metrics["vs_vwap_pct"],
        "bias_label": world.bias_label(symbol),
        "tags": _tags(symbol, watchlist_name),
    }


def _tags(symbol: str, watchlist_name: str) -> list[dict[str, Any]]:
    """Today's pattern signals on `symbol`, then the alert-only strategies on this list that have not
    fired on it yet (armed). The row shows at most `TAG_LIMIT`."""
    tags: list[dict[str, Any]] = [
        {"kind": "pattern", "label": signal["strategy_name"], "at": signal["bar_time"]}
        for signal in world.signals()
        if signal["symbol"] == symbol and signal["kind"] == "pattern"
    ]
    for strategy in world.alert_strategies():
        universe = strategy["spec"]["watch"]["universe"]
        if strategy["stage"] != "alert_only" or universe.get("watchlist") != watchlist_name:
            continue
        fired = {fire["symbol"] for fire in world.replay_fires(strategy["replay_key"])}
        if symbol not in fired:
            tags.append({"kind": "armed", "label": f"{strategy['name']} armed", "at": None})
    return tags[:TAG_LIMIT]
