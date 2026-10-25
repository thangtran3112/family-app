"""The screener universe (02m §b1, §b3): seed lists, market strip, and the provider's most-actives and movers.

Run 0's scan basis, kept: the seed watchlists and the market strip, plus Alpaca's most-actives (by volume
and by trades, top 100 each) and movers (top 50 gainers and losers), reduced to plain tickers. This is not
the full US equity list; the screener's "Scanned N" line says so.

`universe_symbols` carries every outcome so the screener's header can count them without extra storage:
a non-plain ticker is stored inactive (`floor_reason.reason == "non_plain_ticker"`), a candidate with fewer
than two daily bars has `reason == "no_daily_data"`, one below the floor has `reason == "below_floor"`
with the numbers, and one that passes has `passed_floor` true and no reason.
"""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ai_trading_common.errors import NotConfigured, ProviderError
from ai_trading_common.registry import DataSources
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.cli.seed_technical import SEED_WATCHLISTS
from ai_trading.db.models import SymbolMetrics, UniverseSymbol

MARKET_STRIP = ("SPY", "QQQ", "IWM")
#: Seed watchlists plus the market strip: always in the universe, whatever the provider lists say.
SEED_SYMBOLS = tuple(dict.fromkeys([*MARKET_STRIP, *(s for _, _, symbols in SEED_WATCHLISTS for s in symbols)]))
TOP_ACTIVES = 100
TOP_MOVERS = 50
MIN_PRICE = 5.0
MIN_AVG_VOLUME = 500_000
MIN_DAILY_BARS = 2

PLAIN_TICKER = re.compile(r"[A-Z]{1,5}")
#: Fund names that Alpaca's asset list does not mark as such. A stock name carries "Common Stock", "Inc.", ...
_ETF_NAME = re.compile(
    r"\bETFs?\b|\bETNs?\b|\bSPDR\b|\biShares\b|\bProShares\b|\bDirexion\b|\bVanguard\b|\bSchwab\b.*\bFund\b"
    r"|\bInvesco\b.*\b(Trust|Fund)\b|\bTrust,? Series\b|\bFund\b|\bIndex\b",
    re.IGNORECASE,
)
_STOCK_NAME = re.compile(r"common stock|ordinary shares|depositary|class [a-c]\b|\binc\b|\bcorp", re.IGNORECASE)


def classify_asset_type(symbol: str, name: str) -> str:
    """`etf` or `stock`. The market strip is always `etf`; otherwise a name that looks like a fund and not
    like a company is an ETF. ponytail: a name heuristic, because the asset list has no ETF flag; an ETF
    named like a company reads `stock`, which only affects the label."""
    if symbol in MARKET_STRIP:
        return "etf"
    if _STOCK_NAME.search(name):
        return "stock"
    return "etf" if _ETF_NAME.search(name) else "stock"


def split_plain(symbols: Iterable[str]) -> tuple[list[str], list[str]]:
    """`(kept, dropped)`, each sorted and unique: a plain ticker is one to five capital letters, so
    warrants, units, rights and preferred (`COPL.WS`, `NE.WSA`) drop."""
    unique = sorted({s.strip().upper() for s in symbols if s.strip()})
    return [s for s in unique if PLAIN_TICKER.fullmatch(s)], [s for s in unique if not PLAIN_TICKER.fullmatch(s)]


@dataclass
class UniverseBuild:
    candidates: int = 0
    dropped_non_plain: int = 0
    deactivated: int = 0
    #: Provider calls that failed, by name: `assets`, `most_actives_volume`, ... A failed list shrinks the
    #: candidate set to the others plus the seeds; it never raises, so the seeds always stay scannable.
    failed: dict[str, str] = field(default_factory=dict)


def _try(build: UniverseBuild, name: str, call: Callable[[], list[Any]]) -> list[Any]:
    try:
        return call()
    except NotConfigured as exc:
        build.failed[name] = f"not configured: {exc}"
    except ProviderError as exc:
        build.failed[name] = f"{type(exc).__name__}: {exc}"
    return []


def _upsert(session: Session, values: dict[str, Any]) -> None:
    stmt = pg_insert(UniverseSymbol).values(**values)
    changed = {key: value for key, value in values.items() if key != "symbol"}
    session.execute(stmt.on_conflict_do_update(index_elements=["symbol"], set_=changed))


def build_universe(session: Session, sources: DataSources, *, now: datetime) -> UniverseBuild:
    """Refresh `universe_symbols` from the seeds and the provider lists. Caller commits.

    Names come from the asset list; a symbol it does not list keeps its stored name, else is named by its
    ticker. A symbol that was a candidate before and is not today becomes inactive (its row and its stored
    metrics stay, so a watchlist symbol still shows its numbers). If every provider list failed, the stored
    universe is left alone and only the seeds are refreshed."""
    build = UniverseBuild()
    actives = _try(build, "most_actives_volume", lambda: sources.universe.most_actives("volume", TOP_ACTIVES))
    actives += _try(build, "most_actives_trades", lambda: sources.universe.most_actives("trades", TOP_ACTIVES))
    movers = _try(build, "movers", lambda: sources.universe.movers(TOP_MOVERS))
    assets = _try(build, "assets", sources.universe.assets)
    listed = {a.symbol.upper(): a for a in assets}
    all_lists_failed = len(build.failed) >= 3 and not actives and not movers

    raw = [*SEED_SYMBOLS, *(a.symbol for a in actives), *(m.symbol for m in movers)]
    kept, dropped = split_plain(raw)
    build.candidates, build.dropped_non_plain = len(kept), len(dropped)

    stored = {row.symbol: row for row in session.execute(select(UniverseSymbol)).scalars()}
    for symbol in kept:
        asset = listed.get(symbol)
        previous = stored.get(symbol)
        name = asset.name if asset else (previous.name if previous else symbol)
        exchange = asset.exchange if asset else (previous.exchange if previous else "")
        values = {
            "symbol": symbol,
            "name": name,
            "asset_type": classify_asset_type(symbol, name),
            "exchange": exchange,
            "active": True,
            # A returning symbol keeps its floor result until the next floor pass reads fresh metrics.
            "passed_floor": previous.passed_floor if previous else False,
            "floor_reason": previous.floor_reason if previous else {"reason": "no_daily_data"},
            "updated_at": now,
        }
        _upsert(session, values)
    for symbol in dropped:
        values = {
            "symbol": symbol,
            "name": symbol,
            "asset_type": "stock",
            "exchange": "",
            "active": False,
            "passed_floor": False,
            "floor_reason": {"reason": "non_plain_ticker"},
            "updated_at": now,
        }
        _upsert(session, values)
    if not all_lists_failed:
        gone = [s for s, row in stored.items() if row.active and s not in set(kept)]
        if gone:
            session.execute(
                update(UniverseSymbol).where(UniverseSymbol.symbol.in_(gone)).values(active=False, updated_at=now)
            )
        build.deactivated = len(gone)
    return build


def ensure_universe(session: Session, sources: DataSources, *, now: datetime) -> UniverseBuild | None:
    """Build the universe when nothing beyond the seeds is stored: a fresh install, before its first weekday
    premarket pass, would otherwise hand a practice plan the 17 seed symbols (the first walkthrough scanned 17 of
    17). None when a built universe is already there. A build whose provider lists all failed leaves only the
    seeds, so the next call tries again. Caller commits."""
    active = session.execute(select(func.count()).select_from(UniverseSymbol).where(UniverseSymbol.active.is_(True)))
    if active.scalar_one() > len(SEED_SYMBOLS):
        return None
    return build_universe(session, sources, now=now)


def apply_floor(
    session: Session,
    *,
    now: datetime,
    min_price: float = MIN_PRICE,
    min_avg_volume: int = MIN_AVG_VOLUME,
) -> tuple[int, int]:
    """Set `passed_floor` and `floor_reason` on every active symbol from its stored metrics. Returns
    `(passed, failed)`; a symbol with no metrics row or fewer than two daily bars is `no_daily_data` and
    counts as failed. Caller commits."""
    metrics = {row.symbol: row.metrics for row in session.execute(select(SymbolMetrics)).scalars()}
    passed = failed = 0
    for row in session.execute(select(UniverseSymbol).where(UniverseSymbol.active.is_(True))).scalars():
        values = metrics.get(row.symbol)
        last = None if values is None else values.get("last")
        avg_volume = None if values is None else values.get("avg_volume_20d")
        if last is None or avg_volume is None:
            row.passed_floor, row.floor_reason = False, {"reason": "no_daily_data"}
        elif last >= min_price and avg_volume >= min_avg_volume:
            row.passed_floor, row.floor_reason = True, None
        else:
            row.passed_floor = False
            row.floor_reason = {"reason": "below_floor", "last": last, "avg_volume_20d": avg_volume}
        row.updated_at = now
        passed, failed = (passed + 1, failed) if row.passed_floor else (passed, failed + 1)
    return passed, failed
