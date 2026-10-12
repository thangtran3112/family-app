"""The IBKR streaming-slot allocator (02a §7): at most `cap` symbols get a live subscription, in
priority order `intraday_strategy` > `open_chart` > `covered_call_scan`.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

SlotKind = Literal["intraday_strategy", "open_chart", "covered_call_scan"]

#: Lower sorts first (wins), matching 02a §7's listed priority order.
_PRIORITY: dict[SlotKind, int] = {"intraday_strategy": 0, "open_chart": 1, "covered_call_scan": 2}


@dataclass(frozen=True)
class SlotDemand:
    symbol: str
    kind: SlotKind
    since: datetime


@dataclass(frozen=True)
class SlotDecision:
    symbol: str
    kind: SlotKind  # the highest-priority kind this symbol was demanded under
    since: datetime  # the earliest `since` among that kind's demands for this symbol
    granted: bool
    reason: str | None  # set only when `granted` is False


def allocate(demands: list[SlotDemand], cap: int = 70) -> list[SlotDecision]:
    """One slot per symbol, however many demands name it, counted under its highest-priority kind
    (ties broken by the earliest `since` within that kind). Symbols compete for `cap` slots in
    priority order, then by `since`, then by symbol, so the result is deterministic regardless of
    `demands`' input order."""
    by_symbol: dict[str, list[SlotDemand]] = defaultdict(list)
    for demand in demands:
        by_symbol[demand.symbol].append(demand)

    canonical = []
    for symbol, group in by_symbol.items():
        best_kind = min((d.kind for d in group), key=lambda k: _PRIORITY[k])
        earliest = min(d.since for d in group if d.kind == best_kind)
        canonical.append((symbol, best_kind, earliest))
    canonical.sort(key=lambda c: (_PRIORITY[c[1]], c[2], c[0]))

    decisions = []
    for rank, (symbol, kind, since) in enumerate(canonical):
        granted = rank < cap
        reason = None if granted else f"no streaming slot available (cap {cap})"
        decisions.append(SlotDecision(symbol, kind, since, granted, reason))
    return decisions
