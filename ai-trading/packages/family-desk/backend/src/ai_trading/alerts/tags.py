"""The tags on a watchlist table row (02m §a3.5): today's pattern signals on the symbol, then the live
strategies on this list that have not fired on it today ("armed"). At most `TAG_LIMIT` per row."""

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts import describe
from ai_trading.alerts.service import status_of
from ai_trading.core.calendar import ET, et
from ai_trading.db.models import Signal, Strategy, StrategyVersion, User

TAG_LIMIT = 3


def table_tags(
    session: Session, user_id: int, watchlist_name: str, symbols: list[str], *, now: datetime
) -> dict[str, list[dict[str, Any]]]:
    """`symbol -> tags`, each `{kind, label, at}` (`at` is the signal's bar time, null for an armed strategy)."""
    tags: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
    if not symbols:
        return tags
    today = now.astimezone(ET).date()
    day_start = et(today, "00:00").to_pydatetime()

    fired_today: dict[int, set[str]] = {}
    pattern_tags: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
    rows = session.execute(
        select(Signal.symbol, Signal.bar_time, Strategy.id, Strategy.name, StrategyVersion.spec)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .join(Strategy, Strategy.id == StrategyVersion.strategy_id)
        .where(
            Strategy.owner_user_id == user_id,
            Strategy.archived_at.is_(None),
            Signal.symbol.in_(symbols),
            Signal.bar_time >= day_start,
        )
        .order_by(Signal.bar_time)
    ).all()
    for symbol, bar_time, strategy_id, name, spec in rows:
        fired_today.setdefault(strategy_id, set()).add(symbol)
        if "when" in spec and describe.signal_kind(spec) == "pattern":
            pattern_tags[symbol].append({"kind": "pattern", "label": name, "at": bar_time})

    settings = session.execute(select(User.settings).where(User.id == user_id)).scalar_one()
    paused_all = isinstance(settings, dict) and settings.get("pause_all") is True
    armed = session.execute(
        select(Strategy, StrategyVersion.spec)
        .join(StrategyVersion, StrategyVersion.id == Strategy.current_version_id)
        .where(
            Strategy.owner_user_id == user_id,
            Strategy.archived_at.is_(None),
            Strategy.paused_reason.is_(None),
            Strategy.lane == "technical",
            Strategy.stage.in_(("alert_only", "paper")),
        )
        .order_by(Strategy.id)
    ).all()
    for strategy, spec in armed:
        alert = spec.get("then", {}).get("alert", {})
        universe = spec.get("watch", {}).get("universe", {})
        if (
            paused_all
            or status_of(strategy.stage, alert.get("expiresOn"), None, today.isoformat(), paused_all=False) != "active"
        ):
            continue
        named = universe.get("watchlist") == watchlist_name
        for symbol in symbols:
            listed = symbol in universe.get("symbols", [])
            if (named or listed) and symbol not in fired_today.get(strategy.id, set()):
                tags[symbol].append({"kind": "armed", "label": f"{strategy.name} armed", "at": None})

    return {symbol: (pattern_tags[symbol] + tags[symbol])[:TAG_LIMIT] for symbol in symbols}
