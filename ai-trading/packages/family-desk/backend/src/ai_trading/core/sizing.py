"""Paper-order sizing: a signal's `paperOrder` becomes an exact bracket, or a reason there is none.

Deterministic arithmetic: the paper broker (Phase 6) sends what this returns and nothing else.
Every clamp is recorded so a smaller order can be explained, after the clamp audit trail in
ai-hedge-fund `hedge_fund/risk/limits.py` (the idea, not the code). Prices are not rounded to the
instrument's tick here; the broker does that.
"""

import math
from dataclasses import dataclass
from typing import Any, Literal

Side = Literal["buy", "sell"]


@dataclass(frozen=True)
class Clamp:
    limit: str
    before: int
    after: int


@dataclass(frozen=True)
class Bracket:
    side: Side
    quantity: int
    entry: float
    stop: float
    target: float
    clamps: tuple[Clamp, ...]


@dataclass(frozen=True)
class OrderPlan:
    bracket: Bracket | None
    reason: str | None  # why there is no order


def _floor(value: float) -> int:
    return math.floor(round(value, 9))  # 300 / 0.3 is 999.9999999999999 in binary floating point


def _known(value: float | None) -> bool:
    return value is not None and math.isfinite(value)


def plan_order(
    paper_order: dict[str, Any],
    *,
    entry: float,
    stop_level: float | None = None,
    target_level: float | None = None,
    atr: float | None = None,
    book_equity: float | None = None,
    multiplier: float = 1.0,
    max_position_usd: float | None = None,
) -> OrderPlan:
    """Size `paper_order` (the spec's `then.paperOrder`, as stored) for an entry price.

    `stop_level` and `target_level` are the current values of the spec's level operands, when the
    stop or target is a level. `multiplier` is the futures point value (1 for stocks).
    """

    def no(reason: str) -> OrderPlan:
        return OrderPlan(None, reason)

    if not _known(entry) or entry <= 0:
        return no("entry price is unknown or not positive")

    side: Side = paper_order["side"]
    sign = 1.0 if side == "buy" else -1.0
    stop_spec, target_spec, size = paper_order["stop"], paper_order["target"], paper_order["size"]

    if "atrMultiple" in stop_spec:
        if not _known(atr) or atr <= 0:
            return no("ATR is unknown")
        stop = entry - sign * stop_spec["atrMultiple"] * atr
    else:
        if not _known(stop_level):
            return no("stop level is unknown")
        stop = stop_level
    risk = round(sign * (entry - stop), 9)
    if risk <= 0:
        return no("stop is not on the losing side of the entry")

    if "r" in target_spec:
        target = entry + sign * target_spec["r"] * risk
    else:
        if not _known(target_level):
            return no("target level is unknown")
        target = target_level
    if sign * (target - entry) <= 0:
        return no("target is not on the winning side of the entry")

    if "riskUsd" in size:
        quantity = _floor(size["riskUsd"] / (risk * multiplier))
    elif "pctOfBook" in size:
        if not _known(book_equity) or book_equity <= 0:
            return no("book equity is unknown")
        quantity = _floor(book_equity * size["pctOfBook"] / 100 / (entry * multiplier))
    else:
        quantity = int(size.get("shares", size.get("contracts")))

    clamps: list[Clamp] = []
    if max_position_usd is not None:
        cap = _floor(max_position_usd / (entry * multiplier))
        if quantity > cap:
            if cap < 1:
                return no("maxPositionUsd allows less than one share or contract")
            clamps.append(Clamp("maxPositionUsd", quantity, cap))
            quantity = cap
    if quantity < 1:
        return no("size rounds to zero")
    bracket = Bracket(side, quantity, entry, round(stop, 6), round(target, 6), tuple(clamps))
    return OrderPlan(bracket, None)
