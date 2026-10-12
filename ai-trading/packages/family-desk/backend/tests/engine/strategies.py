"""Shared strategy/watchlist builders for `tests/engine/*.py`, following
`tests/test_db_phase3_tables.py`'s own `_make_user`/`_make_strategy_version` pattern."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert, update
from sqlalchemy.orm import Session

from ai_trading.db.models import Strategy, StrategyVersion, User, Watchlist, WatchlistItem

NOW = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)


def make_user(session: Session, email: str = "owner@example.test") -> int:
    return session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()


def make_strategy(
    session: Session,
    user_id: int,
    spec: dict[str, Any],
    *,
    name: str = "test-strategy",
    stage: str = "alert_only",
    version: int = 1,
) -> tuple[int, int]:
    """Inserts a `strategies` row at `stage` and one `strategy_versions` row holding `spec`,
    points `current_version_id` at it, and returns `(strategy_id, version_id)`."""
    strategy_id = session.execute(
        insert(Strategy).values(owner_user_id=user_id, name=name, stage=stage, created_at=NOW).returning(Strategy.id)
    ).scalar_one()
    version_id = session.execute(
        insert(StrategyVersion)
        .values(
            strategy_id=strategy_id,
            version=version,
            schema_version=1,
            spec=spec,
            created_by=user_id,
            created_at=NOW,
        )
        .returning(StrategyVersion.id)
    ).scalar_one()
    session.execute(update(Strategy).where(Strategy.id == strategy_id).values(current_version_id=version_id))
    return strategy_id, version_id


def make_watchlist(session: Session, user_id: int, name: str, items: list[tuple[str, str]]) -> int:
    """`items`: a list of `(symbol, asset_type)` pairs."""
    watchlist_id = session.execute(
        insert(Watchlist).values(user_id=user_id, name=name, horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    for symbol, asset_type in items:
        session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol=symbol, asset_type=asset_type))
    return watchlist_id


def make_spec(
    *,
    when: dict[str, Any],
    run_on: str = "bar_close_1m",
    universe: dict[str, Any] | None = None,
    session_name: str = "regular",
    channels: list[str] | None = None,
    severity: str | None = None,
    paper_order: dict[str, Any] | None = None,
) -> dict[str, Any]:
    then: dict[str, Any] = {"alert": {"channels": channels or ["inbox"]}}
    if severity is not None:
        then["alert"]["severity"] = severity
    if paper_order is not None:
        then["paperOrder"] = paper_order
    return {
        "schemaVersion": 1,
        "name": "Test strategy",
        "watch": {"universe": universe or {"symbols": ["TEST"]}, "session": session_name, "runOn": run_on},
        "when": when,
        "then": then,
    }
