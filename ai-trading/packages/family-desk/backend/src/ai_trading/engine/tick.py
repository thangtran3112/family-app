"""The scheduler's and `api`'s own tick (PROTO-BRIEF.md section 4 L2; 02a section 5): re-evaluates
every live strategy over whatever is already in Postgres. There is no true per-minute "bar close"
event to subscribe to in Phase 3 (no IBKR, D-c) -- `evaluate()` itself reports every candidate
closed by `as_of` on every call, so catch-up safety falls out of calling `evaluate()` again plus
the outbox's unique-constraint dedupe, not out of any streaming machinery or tick-side bookkeeping.
"""

from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import Asset
from ai_trading.core.evaluate import INTRADAY_CADENCES, SignalCandidate, evaluate
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Strategy, StrategyVersion, Watchlist, WatchlistItem
from ai_trading.engine import degraded
from ai_trading.engine.outbox import AlertSpec, record_signal

_LIVE_CADENCES = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})

#: How far back `tick` reads `bars_1m` on every call. `bars_1m`'s own retention is 90 days
#: (`ai_trading.data.bars._RETENTION_1M`); this stays comfortably inside it so every spec's own
#: rolling window (the widest is `rvol`'s 60-day lookback) always has enough history, at the cost
#: of reading more rows than most specs actually need each tick.
#: ponytail: a fixed 70-day window, not sized per spec; narrow it to each spec's own widest lookback
#: if reading this much `bars_1m` every 60s ever shows up as a real bottleneck.
_BARS_1M_LOOKBACK_DAYS = 70

#: `bars_1d` is read from the earliest day Alpaca's free plan can ever have supplied, every tick --
#: simpler than computing each spec's actual window (n-day levels up to 260 days, pivots up to a
#: month, support/resistance up to 260 days), and daily bars are cheap enough that over-reading
#: them is not worth avoiding.
_BARS_1D_START = ALPACA_FREE_HISTORY_START


@dataclass(frozen=True)
class TickResult:
    evaluated_strategies: int
    new_signals: int
    errors: list[str] = field(default_factory=list)  # one strategy's evaluation failure never aborts the others


def tick(
    session: Session,
    *,
    now: datetime,
    live_cadences: frozenset[str] = _LIVE_CADENCES,
) -> TickResult:
    """Called every ~60s from `api`'s own background loop (bar_close_* cadences, the default
    `live_cadences`) or once per job slot from `jobs.scheduler` (`live_cadences={"premarket_0830"}`
    etc.). For every `strategies` row with stage in ("alert_only", "paper") whose current version's
    `spec.watch.runOn` is in `live_cadences`, resolves its universe's symbols and evaluates each:

      1. asset = "future" if the symbol's watchlist item/inline prefix marks it a future, else "stock"
      2. quality = degraded.quality_for(asset, spec.watch.runOn); "unavailable" -> skip, no bars read
      3. bars_1m/bars_1d = ai_trading.data.bars.read_bars(...) as needed by spec.watch.runOn
      4. candidates = ai_trading.core.evaluate.evaluate(spec, symbol, asset, ..., as_of=now)
      5. for each candidate: outbox.record_signal(...); counted as a new signal only when it returns True

    A symbol's `evaluate()` raising `ValueError` (e.g. missing 1-minute bars) is caught, appended to
    `errors`, and does not stop the rest of the tick -- this IS Review Focus 2: calling `tick` twice
    with the same `now` is idempotent (the second call's `new_signals` is 0, enforced by the outbox's
    own unique constraint), and calling it once after several missed intervals evaluates every bar
    `evaluate()` reports closed by `now` exactly once each. Commits once at the end.
    """
    as_of = _as_of(now)
    evaluated_strategies = 0
    new_signals = 0
    errors: list[str] = []

    strategies = session.execute(select(Strategy).where(Strategy.stage.in_(("alert_only", "paper")))).scalars().all()
    for strategy in strategies:
        version = _current_version(session, strategy)
        if version is None:
            continue
        spec = StrategySpecV1.model_validate(version.spec)
        if spec.watch.runOn not in live_cadences:
            continue
        alert = AlertSpec(channels=list(spec.then.alert.channels), severity=spec.then.alert.severity or "info")

        for symbol, asset in _universe(session, strategy, spec):
            quality = degraded.quality_for(asset, spec.watch.runOn)
            if quality == "unavailable":
                continue  # no data source at all for a future in Phase 3 (D-c): never fires
            evaluated_strategies += 1
            try:
                candidates = _evaluate_symbol(session, spec, symbol, asset, as_of)
            except ValueError as exc:
                errors.append(f"{strategy.name} {symbol}: {exc}")
                continue
            for candidate in candidates:
                wrote = record_signal(
                    session,
                    strategy_version_id=version.id,
                    owner_user_id=strategy.owner_user_id,
                    symbol=symbol,
                    candidate=candidate,
                    data_quality=quality,
                    alert=alert,
                    now=now,
                )
                if wrote:
                    new_signals += 1

    session.commit()
    return TickResult(evaluated_strategies=evaluated_strategies, new_signals=new_signals, errors=errors)


def _as_of(now: datetime) -> pd.Timestamp:
    ts = pd.Timestamp(now)
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def _current_version(session: Session, strategy: Strategy) -> StrategyVersion | None:
    if strategy.current_version_id is None:
        return None
    return session.get(StrategyVersion, strategy.current_version_id)


def _universe(session: Session, strategy: Strategy, spec: StrategySpecV1) -> list[tuple[str, Asset]]:
    """`spec.watch.universe`: an inline symbol list, or a watchlist name resolved against the
    strategy owner's own `watchlist_items` (joined through `watchlists` by name and owner).

    An inline symbol has no `asset_type` field in the schema (`Universe1.symbols` is a bare string
    list) -- a leading "/" is the Desk's own futures marker (the schema's own `Symbol` pattern,
    `^\\/?[A-Z][A-Z0-9.]{0,9}$`, already allows one for exactly this reason; `/ES` names the same
    underlying product `ai_trading.core.futures` calls "ES"), stripped before use as a bar symbol.
    """
    universe = spec.watch.universe
    if hasattr(universe, "symbols"):
        return [_inline_symbol(item.root) for item in universe.symbols]
    rows = session.execute(
        select(WatchlistItem.symbol, WatchlistItem.asset_type)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.user_id == strategy.owner_user_id, Watchlist.name == universe.watchlist)
    ).all()
    return [(symbol, "future" if asset_type == "future" else "stock") for symbol, asset_type in rows]


def _inline_symbol(root: str) -> tuple[str, Asset]:
    return (root[1:], "future") if root.startswith("/") else (root, "stock")


def _evaluate_symbol(
    session: Session, spec: StrategySpecV1, symbol: str, asset: Asset, as_of: pd.Timestamp
) -> list[SignalCandidate]:
    bars_1d = read_bars(session, symbol, "1d", _BARS_1D_START, as_of.date(), asset, as_of=as_of)
    bars_1m = None
    if spec.watch.runOn in INTRADAY_CADENCES:
        start = (as_of - pd.Timedelta(days=_BARS_1M_LOOKBACK_DAYS)).date()
        bars_1m = read_bars(session, symbol, "1m", start, as_of.date(), asset, as_of=as_of)
    return evaluate(spec, symbol, asset, bars_1m=bars_1m, bars_1d=bars_1d, as_of=as_of)
