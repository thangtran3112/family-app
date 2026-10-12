"""The futures roll map (02a §9, Review Focus 4): contiguous front-month windows from
`ai_trading.core.futures`' roll dates, stored in `futures_rolls`, and a difference back-adjusted
continuous series stitched from them so indicators and levels never see a fake cross-contract gap.
"""

from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core import futures
from ai_trading.db.models import FuturesRoll


@dataclass(frozen=True)
class RollWindow:
    product: str  # the extracted product, e.g. "ES" (never a micro/mini alias of it)
    contract_month: date  # first of the delivery month
    contract_symbol: str  # e.g. "ESZ6"; parses back through `futures._extract_product`
    active_from: date
    active_until: date  # inclusive


def _contract_symbol(product: str, contract_month: date) -> str:
    """`product` + its CME month code + the contract year's last digit, e.g. "ESZ6" for December
    2026 -- the shortest form `futures._extract_product`'s suffix regex (`[FGHJKMNQUVXZ]\\d{1,4}`)
    accepts, matching how CME itself abbreviates a front-month symbol."""
    return f"{product}{futures.MONTH_CODES[contract_month.month]}{contract_month.year % 10}"


def roll_windows(product: str, start: date, end: date) -> list[RollWindow]:
    """Contiguous, non-overlapping front-month windows covering `[start, end]`: each window's
    `active_until` is the day before the next contract's roll date, and that roll date is the
    next window's `active_from` -- so there is no gap and no overlap between them."""
    extracted = futures._extract_product(product)
    windows: list[RollWindow] = []
    window_start = start
    contract_month = futures.front_month(extracted, window_start)
    while window_start <= end:
        roll = futures.roll_date(extracted, contract_month)
        window_end = min(roll - timedelta(days=1), end)
        windows.append(
            RollWindow(
                product=extracted,
                contract_month=contract_month,
                contract_symbol=_contract_symbol(extracted, contract_month),
                active_from=window_start,
                active_until=window_end,
            )
        )
        if window_end >= end:
            break
        window_start = roll
        contract_month = futures.front_month(extracted, roll)
    return windows


def store_roll_windows(session: Session, windows: list[RollWindow]) -> None:
    """Idempotent upsert of `windows` into `futures_rolls`, keyed by (product, contract_month)."""
    if not windows:
        return
    rows = [
        {
            "product": w.product,
            "contract_month": w.contract_month,
            "contract_symbol": w.contract_symbol,
            "active_from": w.active_from,
            "active_until": w.active_until,
        }
        for w in windows
    ]
    stmt = pg_insert(FuturesRoll).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["product", "contract_month"],
        set_={
            "contract_symbol": stmt.excluded.contract_symbol,
            "active_from": stmt.excluded.active_from,
            "active_until": stmt.excluded.active_until,
        },
    )
    session.execute(stmt)


def _last_common_bar(old: pd.Series, new: pd.Series, before: date) -> date | None:
    """The latest date on or before `before` that both `old` and `new` (daily series indexed by
    trading day) hold a non-NaN value for -- the bridge a difference back-adjustment needs at a
    roll."""
    candidates = old.index[old.index <= before]
    for d in sorted(candidates, reverse=True):
        if d in new.index and pd.notna(old.loc[d]) and pd.notna(new.loc[d]):
            return d
    return None


def continuous(
    windows: list[RollWindow], bars_by_contract: dict[str, pd.DataFrame], *, field: str = "close"
) -> pd.Series:
    """Stitches each window's own contract bars into one series, difference back-adjusted at every
    roll: the new contract's (already-adjusted) price minus the old contract's raw price, both at
    the last bar before the roll where both contracts have data. The newest window carries no
    adjustment, so the latest segment is always at real prices (02a §11, Review Focus 4: "the roll
    test -- no cross-contract gap").

    Raises `ValueError` if two consecutive contracts share no bar on or before a window's
    `active_until`: back-adjusting across a gap would have to guess an offset, which this never
    does (AGENTS.md "unknown data never fires or guesses"). A window whose contract has no bars in
    `bars_by_contract` raises `ValueError` too.
    """
    if not windows:
        return pd.Series(dtype=float)
    absent = [w.contract_symbol for w in windows if w.contract_symbol not in bars_by_contract]
    if absent:
        raise ValueError(f"no bars supplied for contract {absent[0]!r}")
    ordered = sorted(windows, key=lambda w: w.active_from)
    pieces: list[pd.Series] = []
    offset = 0.0
    for i in range(len(ordered) - 1, -1, -1):
        w = ordered[i]
        raw = bars_by_contract[w.contract_symbol][field]
        if i < len(ordered) - 1:
            next_w = ordered[i + 1]
            next_raw = bars_by_contract[next_w.contract_symbol][field]
            bridge = _last_common_bar(raw, next_raw, w.active_until)
            if bridge is None:
                raise ValueError(
                    f"no common bar between {w.contract_symbol!r} and {next_w.contract_symbol!r} "
                    f"near the roll on {next_w.active_from}"
                )
            # `offset` here is still the one computed for `next_w` (0.0 for the newest window).
            offset = (next_raw.loc[bridge] + offset) - raw.loc[bridge]
        else:
            offset = 0.0
        segment = raw.loc[(raw.index >= w.active_from) & (raw.index <= w.active_until)]
        pieces.append(segment + offset)
    pieces.reverse()
    return pd.concat(pieces).sort_index()
