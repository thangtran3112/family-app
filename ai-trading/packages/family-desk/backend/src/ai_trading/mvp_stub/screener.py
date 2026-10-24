"""Stub answers for `/api/desk/screener*` (02m §a3.4), read from the snapshot's `screener` block.

Ids are the world's (filters 1..10, the seeds). A copy gets id 11 and is echoed, never persisted, so
every id past the seeds is unknown to the stub.
"""

from functools import cache
from typing import Any

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.mvp_stub import SNAPSHOT_AS_OF, et_to_utc, snapshot, stamp, world
from ai_trading.screener.columns import table_columns

COPY_ID = 11
PREVIEW_TOP = 5


def _screener(key: str) -> dict[str, Any]:
    return snapshot()["screener"]["screeners"][key]


def _evaluation_point(screener: dict[str, Any]) -> str:
    """The first match's evaluation point (ET in the snapshot) as UTC; the snapshot's as_of when no match."""
    return et_to_utc(screener["matches"][0]["evaluation_point"]) if screener["matches"] else SNAPSHOT_AS_OF


@cache
def seed_spec(key: str) -> dict[str, Any]:
    """A seed's template, validated and dumped the way the API returns specs."""
    entry = next(e for e in load_catalog().entries if e.kind == "filter" and e.id == key)
    spec = FilterStrategySpecV1.model_validate(load_template(entry.file))
    return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


def find_filter(filter_id: int) -> dict[str, Any] | None:
    row = next((r for r in world.filters() if r["id"] == filter_id), None)
    return None if row is None else {**row, "origin": "seed"}


def _list_row(row: dict[str, Any]) -> dict[str, Any]:
    screener = _screener(row["key"])
    return {
        "id": row["id"],
        "name": row["name"],
        "origin": "seed",
        "seed_key": row["key"],
        "read_only": True,
        "run_on": row["run_on"],
        "session": row["session"],
        "last_run": {
            "evaluation_point": _evaluation_point(screener),
            "matches_total": screener["matches_total"],
            "scanned": screener["scanned"],
            "stamp": stamp(),
        },
    }


def filter_list() -> list[dict[str, Any]]:
    return [_list_row(row) for row in world.filters()]


def _user_detail(filter_id: int, spec: dict[str, Any], *, version: int, default_spec: dict[str, Any] | None):
    return {
        "id": filter_id,
        "name": spec["name"],
        "origin": "user",
        "read_only": False,
        "version": version,
        "spec": spec,
        "default_spec": default_spec,
        "stamp": stamp(),
    }


def filter_detail(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "origin": "seed",
        "read_only": True,
        "version": 1,
        "spec": seed_spec(row["key"]),
        "default_spec": None,
        "stamp": stamp(),
    }


def copy_detail(row: dict[str, Any]) -> dict[str, Any]:
    seed = seed_spec(row["key"])
    return _user_detail(COPY_ID, {**seed, "name": f"{row['name']} (copy)"}, version=1, default_spec=seed)


def saved_detail(spec: dict[str, Any]) -> dict[str, Any]:
    """A new filter from a spec body: echoed as id 11, never persisted."""
    return _user_detail(COPY_ID, spec, version=1, default_spec=None)


def edited_detail(filter_id: int, spec: dict[str, Any]) -> dict[str, Any]:
    return _user_detail(filter_id, spec, version=2, default_spec=None)


def results(row: dict[str, Any]) -> dict[str, Any]:
    key = row["key"]
    screener = _screener(key)
    return {
        "filter_id": row["id"],
        "name": row["name"],
        "run_on": screener["runOn"],
        "session": screener["session"],
        "rank": screener["rank"],
        "liquidity": screener["liquidity"],
        "evaluation_point": _evaluation_point(screener),
        "scanned": screener["scanned"],
        "no_data_on_eval_day": screener["no_data_on_eval_day"],
        "matches_total": screener["matches_total"],
        "matches_returned": screener["matches_returned"],
        "stamp": stamp(),
        "table_columns": table_columns(seed_spec(key)),
        "matches": [
            {
                "symbol": match["symbol"],
                "matched_since": et_to_utc(match["matched_since"]),
                "rank_value": match["rank_value"],
                "operands": match["operands"],
                "columns": match["columns"],  # Metrics ignores keys outside the shared set
            }
            for match in screener["matches"]
        ],
    }


def universe_scanned() -> int:
    return snapshot()["screener"]["universe"]["scanned"]


def preview(name: str) -> dict[str, Any]:
    """Totals for a spec whose name is a world filter's; any other spec has no stored result to show."""
    scanned = universe_scanned()
    row = next((r for r in world.filters() if r["name"] == name), None)
    if row is None:
        return {"problems": [], "matches_total": None, "scanned": scanned, "top": []}
    screener = _screener(row["key"])
    return {
        "problems": [],
        "matches_total": screener["matches_total"],
        "scanned": scanned,
        "top": [{"symbol": m["symbol"], "rank_value": m["rank_value"]} for m in screener["matches"][:PREVIEW_TOP]],
    }


def universe() -> dict[str, Any]:
    basis = snapshot()["screener"]["universe"]
    return {
        "scan_basis": basis["scan_basis"],
        "candidates": basis["candidates_after_symbol_filter"],
        "scanned": basis["scanned"],
        "dropped_non_plain_tickers": len(basis["dropped_non_plain_tickers"]),
        "no_daily_data": len(basis["no_daily_data"]),
        "liquidity_floor": basis["liquidity_floor"],
        "stamp": stamp(),
    }
