"""Stub builders for the alerts inbox, the delivery log, and alert strategies (02m §a3.7). They return plain
dicts that the routes in `api/alerts.py` and `api/alert_strategies.py` validate against their response models.
Everything comes from `mvp_stub.world` and the snapshot, so ids line up across the inbox, the signals, and the
strategy list. Nothing here writes anywhere."""

from typing import Any

from ai_trading.alerts import describe
from ai_trading.mvp_stub import SNAPSHOT_AS_OF, et_to_utc, snapshot, world

#: A strategy whose `expires_on` is before this date is `expired` (the stub's "today", the day after the snapshot).
STUB_TODAY = "2026-10-24"
#: The one history entry every seeded strategy has (the seed day).
STUB_CREATED_AT = "2026-10-22T14:00:00Z"
#: How many 15m bars the fire thumbnail shows (02m §a3.7).
THUMB_BARS = 40
#: How many symbols a filter source resolves to in the stub (the top of the matching snapshot screener).
SCREENER_SYMBOLS = 5
MARKED_IN_STUB = 2
#: Delivery status of the two newest telegram-channel alerts in the log: one held by quiet hours, one failed.
_TELEGRAM_FIXTURE = {0: "held_quiet_hours", 1: "failed"}


def _num(value: Any) -> float | None:
    return None if value is None else float(value)


# -- inbox and log --------------------------------------------------------------------------------------


def inbox(
    *, unread: bool | None, symbol: str | None, strategy_id: int | None, limit: int, offset: int
) -> list[dict[str, Any]]:
    rows = list(reversed(world.inbox()))  # world.inbox() is oldest first; the API is newest first
    if unread is not None:
        rows = [row for row in rows if (row["read_at"] is None) == unread]
    if symbol is not None:
        rows = [row for row in rows if row["symbol"] == symbol]
    if strategy_id is not None:
        rows = [row for row in rows if row["strategy_id"] == strategy_id]
    return rows[offset : offset + limit]


def mark_read(alert_id: int) -> dict[str, Any] | None:
    """The fixture alert with `read_at` set (not persisted), or None when the id is not in the fixture inbox."""
    row = next((row for row in world.inbox() if row["id"] == alert_id), None)
    return None if row is None else {**row, "read_at": SNAPSHOT_AS_OF}


def mark_all_read() -> dict[str, int]:
    return {"marked": MARKED_IN_STUB}


def _log_rows() -> list[dict[str, Any]]:
    """One row per delivery, newest alert first. Every alert has an inbox row (delivered). A telegram row
    follows when the strategy lists telegram: the two newest such alerts get held and failed, the rest no_channel
    (no telegram connection in the stub)."""
    channels = {row["id"]: row["channels"] for row in world.alert_strategies()}
    rows: list[dict[str, Any]] = []
    telegram_seen = 0
    for alert in reversed(world.inbox()):
        deliveries = [("inbox", "delivered")]
        if "telegram" in channels[alert["strategy_id"]]:
            deliveries.append(("telegram", _TELEGRAM_FIXTURE.get(telegram_seen, "no_channel")))
            telegram_seen += 1
        for channel, status in deliveries:
            rows.append(
                {
                    "delivery_id": len(rows) + 1,
                    "alert_id": alert["id"],
                    "created_at": alert["created_at"],
                    "symbol": alert["symbol"],
                    "strategy_id": alert["strategy_id"],
                    "strategy_name": alert["strategy_name"],
                    "channel": channel,
                    "status": status,
                }
            )
    return rows


def log(*, status: str | None, symbol: str | None, limit: int, offset: int) -> list[dict[str, Any]]:
    rows = _log_rows()
    if status is not None:
        rows = [row for row in rows if row["status"] == status]
    if symbol is not None:
        rows = [row for row in rows if row["symbol"] == symbol]
    return rows[offset : offset + limit]


# -- alert strategies -----------------------------------------------------------------------------------


def watchlist_symbols(name: str) -> list[str]:
    return next((list(wl["symbols"]) for wl in world.watchlists().values() if wl["name"] == name), [])


def screener_symbols(name: str) -> list[str]:
    """A filter source's stub resolution: the top symbols of the snapshot screener that the seed filter runs."""
    key = next((f["key"] for f in world.filters() if f["name"] == name), None)
    if key is None:
        return []
    matches = snapshot()["screener"]["screeners"].get(key, {}).get("matches", [])
    return [match["symbol"] for match in matches[:SCREENER_SYMBOLS]]


def resolved_symbols(universe: dict[str, Any]) -> list[str]:
    if "symbols" in universe:
        return list(universe["symbols"])
    if "watchlist" in universe:
        return watchlist_symbols(universe["watchlist"])
    return screener_symbols(universe["filter"])


def find_strategy(strategy_id: int) -> dict[str, Any] | None:
    """The stored (fixture) row: the base fields, the spec, and the replay key the derived values come from."""
    return next((row for row in world.alert_strategies() if row["id"] == strategy_id), None)


def _spec_fields(spec: dict[str, Any]) -> dict[str, Any]:
    alert = spec["then"]["alert"]
    return {
        "name": spec["name"],
        "run_on": spec["watch"]["runOn"],
        "frequency": alert.get("frequency", "once_per_bar"),
        "cooldown_minutes": spec.get("limits", {}).get("cooldownMinutes"),
        "expires_on": alert.get("expiresOn"),
        "channels": alert["channels"],
        "severity": alert.get("severity", "info"),
    }


def _status(stage: str, expires_on: str | None, paused_reason: str | None) -> str:
    if stage == "draft":
        return "draft"
    if expires_on is not None and expires_on < STUB_TODAY:
        return "expired"
    return "paused" if paused_reason else "active"


def _source(universe: dict[str, Any]) -> dict[str, Any]:
    if "watchlist" in universe:
        name = universe["watchlist"]
        watchlist_id = next((wl["id"] for wl in world.watchlists().values() if wl["name"] == name), None)
        return {"kind": "watchlist", "id": watchlist_id, "label": name}
    if "symbols" in universe:
        return {"kind": "symbol", "id": None, "label": universe["symbols"][0]}
    name = universe["filter"]
    filter_id = next((f["id"] for f in world.filters() if f["name"] == name), None)
    return {"kind": "filter", "id": filter_id, "label": name}


def strategy_out(row: dict[str, Any]) -> dict[str, Any]:
    """`AlertStrategyOut` for a stored row. Every field the spec carries is read from the row's spec."""
    spec = row["spec"]
    fields = _spec_fields(spec)
    fires = world.replay_fires(row["replay_key"])
    return {
        "id": row["id"],
        "name": fields["name"],
        "origin": row["origin"],
        "stage": row["stage"],
        "status": _status(row["stage"], fields["expires_on"], row["paused_reason"]),
        "paused_reason": row["paused_reason"],
        "version": row["version"],
        "source": _source(spec["watch"]["universe"]),
        "category": describe.category(spec),
        "run_on": fields["run_on"],
        "frequency": fields["frequency"],
        "cooldown_minutes": fields["cooldown_minutes"],
        "expires_on": fields["expires_on"],
        "channels": fields["channels"],
        "severity": fields["severity"],
        "last_fired_at": max((fire["bar_time"] for fire in fires), default=None),
        "fires_7d": len(fires),
        "spec": spec,
    }


def strategies(
    *, status: str | None, category: str | None, symbol: str | None, watchlist_id: int | None, sort: str
) -> list[dict[str, Any]]:
    rows = [strategy_out(row) for row in world.alert_strategies()]
    if status is not None:
        rows = [row for row in rows if row["status"] == status]
    if category is not None:
        rows = [row for row in rows if row["category"] == category]
    if symbol is not None:
        rows = [row for row in rows if symbol in resolved_symbols(row["spec"]["watch"]["universe"])]
    if watchlist_id is not None:
        rows = [row for row in rows if row["source"]["kind"] == "watchlist" and row["source"]["id"] == watchlist_id]
    if sort == "last_fired":
        rows.sort(key=lambda row: row["last_fired_at"] or "", reverse=True)  # ISO UTC strings order by time
    elif sort == "status":
        rows.sort(key=lambda row: (row["status"], row["name"].casefold()))
    else:
        rows.sort(key=lambda row: row["name"].casefold())
    return rows


def detail(row: dict[str, Any], versions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    history = versions or [{"version": row["version"], "created_at": STUB_CREATED_AT, "change_note": None}]
    return {**strategy_out(row), "versions": history}


def new_strategy(spec: dict[str, Any], *, save_as: str) -> dict[str, Any]:
    """A new user strategy (id after the fixture world, not persisted). `save_as: on` is only reachable with the
    runtime flag on, so it lands at `alert_only`; `draft` stays draft."""
    row = {
        "id": len(world.alert_strategies()) + 1,
        "origin": "user",
        "stage": "alert_only" if save_as == "on" else "draft",
        "paused_reason": None,
        "version": 1,
        "replay_key": None,
        "spec": spec,
    }
    return strategy_out(row)


def revise(row: dict[str, Any], spec: dict[str, Any], change_note: str | None) -> dict[str, Any]:
    """The next version of `row` with `spec` (not persisted): the derived fields come from the new spec."""
    new_row = {**row, "spec": spec, "version": row["version"] + 1}
    versions = [
        {"version": row["version"], "created_at": STUB_CREATED_AT, "change_note": None},
        {"version": new_row["version"], "created_at": SNAPSHOT_AS_OF, "change_note": change_note},
    ]
    return detail(new_row, versions)


def pause(row: dict[str, Any], reason: str) -> dict[str, Any]:
    return strategy_out({**row, "paused_reason": reason})


def resume(row: dict[str, Any]) -> dict[str, Any]:
    """Clears the pause; a draft moves to `alert_only`. The caller checks the runtime flag before a draft resume."""
    stage = "alert_only" if row["stage"] == "draft" else row["stage"]
    return strategy_out({**row, "paused_reason": None, "stage": stage})


def thumb(symbol: str, bar_time: str) -> list[dict[str, Any]]:
    """Up to `THUMB_BARS` 15m bars ending at the fire's bar; the last bars when the fire's bar is not in the
    snapshot. A symbol outside the trimmed snapshot has no bars."""
    block = snapshot()["symbols"].get(symbol)
    if block is None:
        return []
    frame = block["bars"]["15m"]
    column = {name: index for index, name in enumerate(frame["columns"])}
    rows = frame["rows"]
    stamps = [et_to_utc(row[column["time_et"]]) for row in rows]
    end = stamps.index(bar_time) + 1 if bar_time in stamps else len(rows)
    return [
        {
            "t": stamps[index],
            "o": _num(rows[index][column["o"]]),
            "h": _num(rows[index][column["h"]]),
            "l": _num(rows[index][column["l"]]),
            "c": _num(rows[index][column["c"]]),
            "v": _num(rows[index][column["v"]]),
        }
        for index in range(max(0, end - THUMB_BARS), end)
    ]


def fires(row: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    """The strategy's replay fires, newest first, with the signal id, deliveries, and a 15m thumbnail."""
    signal_ids = {(s["strategy_id"], s["symbol"], s["bar_time"]): s["id"] for s in world.signals()}
    channels = row["spec"]["then"]["alert"]["channels"]
    newest_first = sorted(world.replay_fires(row["replay_key"]), key=lambda fire: fire["bar_time"], reverse=True)
    out = []
    for fire in newest_first[:limit]:
        deliveries = [{"channel": "inbox", "status": "delivered"}]
        if "telegram" in channels:
            deliveries.append({"channel": "telegram", "status": "no_channel"})
        out.append(
            {
                "signal_id": signal_ids.get((row["id"], fire["symbol"], fire["bar_time"]), 0),
                "symbol": fire["symbol"],
                "bar_time": fire["bar_time"],
                "evidence": fire["evidence"],
                "deliveries": deliveries,
                "thumb": {"interval": "15m", "bars": thumb(fire["symbol"], fire["bar_time"])},
            }
        )
    return out
