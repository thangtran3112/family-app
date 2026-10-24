"""Stub builders for `/api/desk/library`: the example occurrence on the detail page and the attach
response. Attach never stores anything in stub mode, so its response is built from the validated spec
alone (02m §a3.6; persistence is a later step)."""

from typing import Any

from ai_trading.alerts.describe import category
from ai_trading.mvp_stub import et_to_utc, snapshot


def example(template: dict[str, Any]) -> dict[str, Any] | None:
    """The first snapshot occurrence of the template's pattern, or None when it has no pattern
    condition or the snapshot holds no occurrence of it."""
    pattern = _pattern_id(template.get("when", {}))
    if pattern is None:
        return None
    occurrence = next((o for o in snapshot()["patterns"]["occurrences"] if o["pattern"] == pattern), None)
    if occurrence is None:
        return None
    return {
        "symbol": occurrence["symbol"],
        "timeframe": occurrence["timeframe"],
        "bar_time": et_to_utc(occurrence["bar_start_et"]),
        "ohlc": occurrence["ohlc"],
    }


def _pattern_id(condition: dict[str, Any]) -> str | None:
    """The `pattern` of the first `op: pattern` node, searching through all/any/not."""
    if condition.get("op") == "pattern":
        return condition["pattern"]
    for child in condition.get("all", []) + condition.get("any", []):
        found = _pattern_id(child)
        if found is not None:
            return found
    if isinstance(condition.get("not"), dict):
        return _pattern_id(condition["not"])
    return None


def attached(index: int, spec: dict[str, Any], *, watchlist_id: int, watchlist_name: str, stage: str) -> dict[str, Any]:
    """The `LibraryAttachOut` of a copy that was not stored. `index` is the entry's position in the
    catalog, so each preset gets a stable id (100 + index)."""
    alert = spec["then"]["alert"]
    return {
        "id": 100 + index,
        "name": spec["name"],
        "origin": "library",
        "stage": stage,
        "status": "active" if stage == "alert_only" else "draft",
        "paused_reason": None,
        "version": 1,
        "source": {"kind": "watchlist", "id": watchlist_id, "label": watchlist_name},
        "category": category(spec),
        "run_on": spec["watch"]["runOn"],
        "frequency": alert.get("frequency", "once_per_bar"),
        "cooldown_minutes": spec.get("limits", {}).get("cooldownMinutes"),
        "expires_on": alert.get("expiresOn"),
        "channels": alert["channels"],
        "severity": alert.get("severity", "info"),
        "last_fired_at": None,
        "fires_7d": 0,
        "spec": spec,
    }
