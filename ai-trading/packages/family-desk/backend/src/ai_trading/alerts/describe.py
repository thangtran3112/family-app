"""Facts derived from an alert strategy spec (02m §a3.7). The plain-English trigger sentence is the
frontend's `describeSpec`; the backend only derives the filterable `category` and the signal `kind`."""

from typing import Any, Literal

Category = Literal["pattern", "indicator", "level", "screener"]
SignalKind = Literal["orb", "vwap_reclaim", "pattern", "rvol", "other"]


def _nodes(condition: dict[str, Any]):
    yield condition
    for child in condition.get("all", []) + condition.get("any", []):
        yield from _nodes(child)
    if "not" in condition:
        yield from _nodes(condition["not"])


def _operands(condition: dict[str, Any]):
    for node in _nodes(condition):
        for side in ("left", "right"):
            if isinstance(node.get(side), dict):
                yield node[side]


def category(spec: dict[str, Any]) -> Category:
    """A `watch.universe.filter` source is `screener`; a `pattern` condition is `pattern`; a level
    operand is `level`; everything else is `indicator`."""
    if "filter" in spec["watch"]["universe"]:
        return "screener"
    if any(node.get("op") == "pattern" for node in _nodes(spec["when"])):
        return "pattern"
    if any("level" in operand for operand in _operands(spec["when"])):
        return "level"
    return "indicator"


def signal_kind(spec: dict[str, Any]) -> SignalKind:
    """The icon family of a signal row on the dashboard and the chart tab."""
    when = spec["when"]
    operands = list(_operands(when))
    if any(node.get("op") == "pattern" for node in _nodes(when)):
        return "pattern"
    if any(operand.get("level") in ("opening_range_high", "opening_range_low") for operand in operands):
        return "orb"
    if any(
        node.get("op") == "crosses_above" and node.get("right", {}).get("series") == "vwap" for node in _nodes(when)
    ):
        return "vwap_reclaim"
    if any(operand.get("series") == "rvol" for operand in operands):
        return "rvol"
    return "other"
