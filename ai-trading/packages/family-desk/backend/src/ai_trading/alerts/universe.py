"""Resolve an alert strategy's source to symbols (02m §b1 `alerts/universe.py`, 02k "filter universe resolution").

A source is one of three things, all scoped to the strategy's owner:

- `symbols`: the listed tickers (a leading `/` marks a future, which the stock runtime cannot evaluate yet);
- `watchlist`: the owner's list of that name, its current items in manage-mode order;
- `filter`: the symbols the owner's saved screener filter of that name matched in its newest run.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import FilterRun, FilterStrategy, FilterStrategyVersion, Strategy, Watchlist, WatchlistItem
from ai_trading.screener.runner import newest_run, run_matches


def _watchlist(session: Session, user_id: int, name: str) -> Watchlist | None:
    return session.execute(
        select(Watchlist).where(Watchlist.user_id == user_id, Watchlist.name == name)
    ).scalar_one_or_none()


def _filter(session: Session, user_id: int, name: str) -> tuple[FilterStrategy, FilterStrategyVersion] | None:
    found = session.execute(
        select(FilterStrategy, FilterStrategyVersion)
        .join(FilterStrategyVersion, FilterStrategyVersion.id == FilterStrategy.current_version_id)
        .where(
            FilterStrategy.owner_user_id == user_id,
            FilterStrategy.archived_at.is_(None),
            FilterStrategy.name == name,
        )
    ).first()
    return None if found is None else (found[0], found[1])


def watchlist_symbols(session: Session, user_id: int, name: str) -> list[tuple[str, str]] | None:
    """`(symbol, asset_type)` of the owner's list in manage-mode order; None when there is no such list."""
    watchlist = _watchlist(session, user_id, name)
    if watchlist is None:
        return None
    return [
        (row.symbol, row.asset_type)
        for row in session.execute(
            select(WatchlistItem)
            .where(WatchlistItem.watchlist_id == watchlist.id)
            .order_by(WatchlistItem.position, WatchlistItem.symbol)
        ).scalars()
    ]


def last_filter_run(session: Session, user_id: int, name: str) -> FilterRun | None:
    """The newest stored run of the owner's filter of that name, or None when it has none (or no such filter)."""
    found = _filter(session, user_id, name)
    return None if found is None else newest_run(session, found[1].id)


def filter_matches(session: Session, strategy: Strategy, name: str) -> list[str] | None:
    """`engine.tick.FilterMatches` over the owner's saved filters: the symbols of the filter's newest run, or None
    when it has no run (no such filter, or the screener has not run it yet)."""
    run = last_filter_run(session, strategy.owner_user_id, name)
    return None if run is None else [match.symbol for match in run_matches(session, run.id)]


def resolve(session: Session, user_id: int, universe: dict[str, Any]) -> list[tuple[str, str]]:
    """`(symbol, asset_type)` for a dumped `watch.universe`. A missing list or filter, or a filter that has
    not run yet, resolves to nothing: the strategy simply has no symbols to watch until one exists."""
    if "symbols" in universe:
        return [(s.removeprefix("/"), "future") if s.startswith("/") else (s, "stock") for s in universe["symbols"]]
    if "watchlist" in universe:
        return watchlist_symbols(session, user_id, universe["watchlist"]) or []
    run = last_filter_run(session, user_id, universe["filter"])
    return [] if run is None else [(match.symbol, "stock") for match in run_matches(session, run.id)]


def source_label(session: Session, user_id: int, universe: dict[str, Any]) -> dict[str, Any]:
    """The `{kind, id, label}` the strategy list shows: the watchlist or filter id when it exists."""
    if "watchlist" in universe:
        watchlist = _watchlist(session, user_id, universe["watchlist"])
        return {"kind": "watchlist", "id": None if watchlist is None else watchlist.id, "label": universe["watchlist"]}
    if "symbols" in universe:
        return {"kind": "symbol", "id": None, "label": universe["symbols"][0]}
    found = _filter(session, user_id, universe["filter"])
    return {"kind": "filter", "id": None if found is None else found[0].id, "label": universe["filter"]}
