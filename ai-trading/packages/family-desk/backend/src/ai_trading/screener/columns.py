"""Table columns for a screener filter (02l D5, 02m §a3.4).

Every filter shows the fixed metric block, then `matched_since`. The filter's `when` operands and its
`rank.by` series add or promote metric columns, so the frontend never maps operands to columns itself.
Input is a dumped `FilterStrategySpecV1` (`model_dump(mode="json", by_alias=True, exclude_none=True)`).
"""

from typing import Any

#: Shown for every filter, in this order (`last` is always first).
FIXED = ("last", "change_pct", "volume", "rvol_10d", "atr_pct_14", "gap_pct_open", "rsi_14", "vs_vwap_pct")

#: Label and display format per metric column. Keys are the snapshot's metric names (02m §a1).
_COLUMNS = {
    "last": ("Last", "price"),
    "change_pct": ("Change %", "pct_signed"),
    "volume": ("Volume", "compact"),
    "rvol_10d": ("RVOL", "ratio"),
    "atr_pct_14": ("ATR %", "pct"),
    "gap_pct_open": ("Gap %", "pct_signed"),
    "rsi_14": ("RSI", "number"),
    "vs_vwap_pct": ("vs VWAP %", "pct_signed"),
    "high_252d": ("52-week high", "price"),
    "dist_to_252d_high_pct": ("vs 52-week high %", "pct_signed"),
}

_PLAIN_SERIES = {"close": "last", "volume": "volume", "vwap": "vs_vwap_pct", "gap_pct": "gap_pct_open"}
# series -> (metric, parameter, value): the metric's name encodes the parameter (rvol_10d is a 10-day RVOL).
# Plain `atr` is absolute, not a percent, so it maps to nothing.
_PARAMETERISED = {
    "rvol": ("rvol_10d", "lookbackDays", 10),
    "rsi": ("rsi_14", "length", 14),
    "atr_pct": ("atr_pct_14", "length", 14),
}


def _nodes(condition: dict[str, Any]):
    yield condition
    for child in condition.get("all", []) + condition.get("any", []):
        yield from _nodes(child)
    if "not" in condition:
        yield from _nodes(condition["not"])


def _operands(condition: dict[str, Any]):
    for node in _nodes(condition):
        for side in ("left", "right"):
            if side in node and "value" not in node[side]:
                yield node[side]


def _metric_keys(operand: dict[str, Any]) -> tuple[str, ...]:
    """The metric columns one operand reads; () when none matches (unknown operands add nothing)."""
    if operand.get("level") == "n_day_high" and operand.get("days") == 252:
        return ("high_252d", "dist_to_252d_high_pct")
    series = operand.get("series")
    if series in _PLAIN_SERIES:
        return (_PLAIN_SERIES[series],)
    if series in _PARAMETERISED:
        metric, parameter, value = _PARAMETERISED[series]
        if operand.get(parameter) == value:
            return (metric,)
    return ()


def table_columns(spec: dict[str, Any]) -> list[dict[str, str]]:
    keys = list(FIXED)
    for operand in _operands(spec["when"]):
        for key in _metric_keys(operand):
            if key not in keys:
                keys.append(key)  # a metric the fixed block lacks goes at the end of the metric block
    rank = spec.get("rank")
    for key in _metric_keys(rank["by"]) if rank else ():
        if key != "last":  # the rank series moves to just after `last`
            if key in keys:
                keys.remove(key)
            keys.insert(1, key)
    columns = []
    for key in keys:
        label, fmt = _COLUMNS[key]
        columns.append({"key": key, "label": label, "format": fmt})
    columns.append({"key": "matched_since", "label": "Since", "format": "time"})
    return columns
