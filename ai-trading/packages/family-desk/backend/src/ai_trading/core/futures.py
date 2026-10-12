"""CME futures: contract specs, month codes, last-trade/first-notice/roll dates, the front month,
and the micro-first sizer for the 12 contracts the Desk trades (02g §4).

`SPECS`, `MONTH_CODES`, and `_extract_product` are adapted from Vibe-Trading
`agent/backtest/engines/global_futures.py` (commit d402c2df, MIT License, Copyright (c) 2026
Vibe-Trading Contributors; see THIRD_PARTY_NOTICES.md), modified to carry only the Desk's 12
contracts (no margins, no price limits, no commissions, no backtest engine), with dollars-per-tick,
listed months, and session hours added. The date functions, the front month, and the sizer are new.
"""

import math
import re
from dataclasses import dataclass
from datetime import date, timedelta

from ai_trading.core.calendar import Asset, previous_session, session

MONTH_CODES: dict[int, str] = {
    1: "F",
    2: "G",
    3: "H",
    4: "J",
    5: "K",
    6: "M",
    7: "N",
    8: "Q",
    9: "U",
    10: "V",
    11: "X",
    12: "Z",
}

EQUITY_INDEX_MONTHS = (3, 6, 9, 12)
EVERY_MONTH = tuple(range(1, 13))
# 02g research (futures-and-covered-call-facts.md §2): CME's commonly active gold months skip
# October even though it is listed; the micro trades it.
GOLD_MONTHS = (2, 4, 6, 8, 12)
MICRO_GOLD_MONTHS = (2, 4, 6, 8, 10, 12)

#: How many CME business days before their delivery deadline the Desk rolls a physically settled
#: contract (CL, MCL, GC, MGC) -- the deadline is `last_trade_date` for CL/MCL and
#: `first_notice_date` for GC/MGC (one roll rule for every physically settled product; owner
#: ruling, 02g §4 review). A work week of lead time keeps a swing position clear of delivery
#: without rolling the contract unreasonably early; no exchange mandates this exact number.
PHYSICAL_ROLL_LEAD_DAYS = 5


@dataclass(frozen=True)
class GlobexHours:
    """The CME Globex session every one of the Desk's 12 futures trades on (02g §4): opens Sunday
    at `open_time` ET, closes Friday at `close_time` ET, with a daily maintenance break from
    `close_time` to `open_time` ET every other trading day."""

    open_time: str  # "18:00" ET, Sunday through the week's open
    close_time: str  # "17:00" ET, the week's close and every day's maintenance-break start


#: One shared instance: every contract in `SPECS` trades the same Globex hours, so each
#: `ContractSpec` references this constant rather than repeating the times 12 times.
GLOBEX_SESSION = GlobexHours(open_time="18:00", close_time="17:00")


@dataclass(frozen=True)
class ContractSpec:
    product: str
    dollars_per_point: float
    tick_size: float
    dollars_per_tick: float
    months: tuple[int, ...]  # listed contract months, 1-12
    session: GlobexHours


SPECS: dict[str, ContractSpec] = {
    "ES": ContractSpec("ES", 50.0, 0.25, 12.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MES": ContractSpec("MES", 5.0, 0.25, 1.25, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "NQ": ContractSpec("NQ", 20.0, 0.25, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MNQ": ContractSpec("MNQ", 2.0, 0.25, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "RTY": ContractSpec("RTY", 50.0, 0.10, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "M2K": ContractSpec("M2K", 5.0, 0.10, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "YM": ContractSpec("YM", 5.0, 1.00, 5.00, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "MYM": ContractSpec("MYM", 0.50, 1.00, 0.50, EQUITY_INDEX_MONTHS, GLOBEX_SESSION),
    "CL": ContractSpec("CL", 1000.0, 0.01, 10.00, EVERY_MONTH, GLOBEX_SESSION),
    "MCL": ContractSpec("MCL", 100.0, 0.01, 1.00, EVERY_MONTH, GLOBEX_SESSION),
    "GC": ContractSpec("GC", 100.0, 0.10, 10.00, GOLD_MONTHS, GLOBEX_SESSION),
    "MGC": ContractSpec("MGC", 10.0, 0.10, 1.00, MICRO_GOLD_MONTHS, GLOBEX_SESSION),
}

#: Mini -> micro and its inverse, e.g. MICRO_OF["ES"] == "MES". A micro is one tenth of its mini
#: (02g §4), true of every `dollars_per_point` pair above.
MICRO_OF: dict[str, str] = {"ES": "MES", "NQ": "MNQ", "RTY": "M2K", "YM": "MYM", "CL": "MCL", "GC": "MGC"}
MINI_OF: dict[str, str] = {micro: mini for mini, micro in MICRO_OF.items()}

_EQUITY_INDEX = frozenset(("ES", "MES", "NQ", "MNQ", "RTY", "M2K", "YM", "MYM"))

_CONTRACT_SUFFIX_RE = re.compile(r"^(?:[FGHJKMNQUVXZ]\d{1,4}|\d{4})$")
_PRODUCTS_LONGEST_FIRST = tuple(sorted(SPECS, key=len, reverse=True))


def _extract_product(symbol: str) -> str:
    """The listed product `symbol` names, e.g. "MESZ6" or "ES.CME" -> "MES"/"ES".

    Adapted from Vibe-Trading's `_extract_product`: the shape-regex fallback for a product outside
    `SPECS` is dropped, since every product this Desk prices is listed here.

    Raises:
        ValueError: `symbol` does not name one of the Desk's 12 products.
    """
    code = symbol.split(".")[0].upper()
    if code in SPECS:
        return code
    for product in _PRODUCTS_LONGEST_FIRST:
        if code.startswith(product) and _CONTRACT_SUFFIX_RE.match(code[len(product) :]):
            return product
    raise ValueError(f"{symbol!r} is not one of the Desk's futures products")


def _shift_month(day: date, months: int) -> date:
    """The first of the month `months` months from `day`'s month (`day`'s own day of month is
    dropped)."""
    total = day.year * 12 + (day.month - 1) + months
    year, month = divmod(total, 12)
    return date(year, month + 1, 1)


def _n_business_days_before(asset: Asset, day: date, n: int) -> date:
    for _ in range(n):
        day = previous_session(asset, day)
    return day


def _last_business_day_of_month(year: int, month: int) -> date:
    return previous_session("future", _shift_month(date(year, month, 1), 1))


def _nth_last_business_day_of_month(year: int, month: int, n: int) -> date:
    """The `n`-th business day counting back from the last one (n=1 is the last business day
    itself, n=3 the third-last)."""
    return _n_business_days_before("future", _last_business_day_of_month(year, month), n - 1)


def _third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    first_friday = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_friday + timedelta(days=14)


def last_trade_date(product: str, contract_month: date) -> date:
    """The last day `product`'s `contract_month` contract trades (`contract_month` is the first
    of that month; the day of month is ignored): the third Friday for equity index (CME's rule);
    CL/MCL's rule (3 business days before the 25th of the prior month, 4 if the 25th is not a
    business day; MCL one business day before CL); the third-last business day of the delivery
    month for GC/MGC.
    """
    product = _extract_product(product)
    if product in _EQUITY_INDEX:
        return _third_friday(contract_month.year, contract_month.month)
    if product in ("CL", "MCL"):
        prior_25th = _shift_month(contract_month, -1).replace(day=25)
        n = 3 if session("future", prior_25th) is not None else 4
        last_trade = _n_business_days_before("future", prior_25th, n)
        return previous_session("future", last_trade) if product == "MCL" else last_trade
    if product in ("GC", "MGC"):
        return _nth_last_business_day_of_month(contract_month.year, contract_month.month, 3)
    raise ValueError(f"no last-trade rule for {product!r}")


def first_notice_date(product: str, contract_month: date) -> date:
    """GC/MGC's first notice day: the last business day of the month before `contract_month`
    (`contract_month` is the first of that month; the day of month is ignored). Only GC and MGC
    are physically settled with a first notice day distinct from their last trade date.
    """
    product = _extract_product(product)
    if product in ("GC", "MGC"):
        before = _shift_month(contract_month, -1)
        return _last_business_day_of_month(before.year, before.month)
    raise ValueError(f"{product!r} has no first notice day (not physically settled that way)")


def roll_date(product: str, contract_month: date) -> date:
    """The date the Desk treats `product`'s `contract_month` contract as no longer the front
    month: the Monday before the third Friday for equity index (CME's rule); `PHYSICAL_ROLL_LEAD_DAYS`
    CME business days before the delivery deadline for every physically settled product -- the
    last trade date for CL/MCL, the first notice date for GC/MGC (one roll rule for all four;
    owner ruling, 02g §4 review).
    """
    product = _extract_product(product)
    if product in _EQUITY_INDEX:
        return last_trade_date(product, contract_month) - timedelta(days=4)
    if product in ("CL", "MCL"):
        deadline = last_trade_date(product, contract_month)
    elif product in ("GC", "MGC"):
        deadline = first_notice_date(product, contract_month)
    else:
        raise ValueError(f"no roll rule for {product!r}")
    return _n_business_days_before("future", deadline, PHYSICAL_ROLL_LEAD_DAYS)


def front_month(product: str, as_of: date) -> date:
    """The contract month (first of month) that is `product`'s front month on `as_of`: the
    earliest listed month whose roll date has not yet passed on `as_of`."""
    product = _extract_product(product)
    months = SPECS[product].months
    cursor = _shift_month(date(as_of.year, as_of.month, 1), -14)
    end = _shift_month(date(as_of.year, as_of.month, 1), 14)
    while cursor <= end:
        if cursor.month in months and as_of < roll_date(product, cursor):
            return cursor
        cursor = _shift_month(cursor, 1)
    raise ValueError(f"no front month for {product!r} found near {as_of}")


@dataclass(frozen=True)
class FuturesSizing:
    symbol: str | None  # the micro contract sized, e.g. "MES"
    contracts: int | None
    risk_per_contract: float | None  # dollars one `symbol` contract risks
    mini_symbol: str | None
    mini_note: str | None  # e.g. "one ES would risk $2,500"
    reason: str | None  # why there is no order


def _format_usd(value: float) -> str:
    return f"${value:,.0f}"


def size_futures(risk_usd: float, entry: float, stop: float, product: str) -> FuturesSizing:
    """Sizes a futures swing in the micro of `product`'s mini/micro pair (02g §4's "it prefers
    micros"): contracts = floor(risk_usd / (|entry - stop| x the micro's dollars per point)), with
    what one mini contract would risk alongside as a size-up note. `product` may name either side
    of the pair. Zero contracts (the risk is too small for even one micro) comes with a reason.
    """

    def no(reason: str) -> FuturesSizing:
        return FuturesSizing(None, None, None, None, None, reason)

    try:
        extracted = _extract_product(product)
    except ValueError as exc:
        return no(str(exc))
    if extracted in MICRO_OF:
        micro = MICRO_OF[extracted]
    elif extracted in MINI_OF:
        micro = extracted
    else:
        return no(f"{extracted!r} has no micro/mini pair")
    mini = MINI_OF[micro]

    if not (math.isfinite(risk_usd) and risk_usd > 0):
        return no("risk is unknown or not positive")
    if not (math.isfinite(entry) and math.isfinite(stop)):
        return no("entry or stop is unknown")
    points = abs(entry - stop)
    if points <= 0:
        return no("stop equals entry")

    micro_spec, mini_spec = SPECS[micro], SPECS[mini]
    risk_per_contract = points * micro_spec.dollars_per_point
    contracts = math.floor(round(risk_usd / risk_per_contract, 9))
    if contracts < 1:
        return no("risk is too small for even one micro contract")

    mini_risk = points * mini_spec.dollars_per_point
    note = f"one {mini} would risk {_format_usd(mini_risk)}"
    return FuturesSizing(micro, contracts, risk_per_contract, mini, note, None)
