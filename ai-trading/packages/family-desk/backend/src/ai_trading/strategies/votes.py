"""The "Her strategies" gauge (02m §a3.3 `gauges.strategies`, 02l §e4): the fourth technical gauge.

Her attached, non-paused alert-only strategies that watch the symbol and run on the viewed timeframe each
vote their catalog bias when their condition is true on the last closed bar; the others on that timeframe
are `watching`. A strategy votes on timeframe T when its cadence equals T: `bar_close_5m`, `bar_close_15m`
and `bar_close_1h` vote on `5m`, `15m` and `1h`; `bar_close_1m` votes on `5m`; `daily_close` on `1d`;
`weekly` on `1w`. `premarket_0830` strategies are always listed as watching. Score and label reuse
`core/bias.py`'s thresholds. With no strategy to show the gauge is None.
"""

import logging
import math
from datetime import datetime
from functools import cache
from typing import Any

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.alerts.service import status_of
from ai_trading.alerts.universe import resolve
from ai_trading.core import bias
from ai_trading.core.calendar import ET
from ai_trading.db.models import Strategy, StrategyVersion, User
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.screener.evaluator import Frames, evaluate_symbol
from ai_trading.screener.runner import StoredBars

log = logging.getLogger(__name__)

#: The timeframe each cadence votes on.
VOTES_ON = {
    "bar_close_5m": "5m",
    "bar_close_15m": "15m",
    "bar_close_1h": "1h",
    "bar_close_1m": "5m",
    "daily_close": "1d",
    "weekly": "1w",
}
_VOTE = {"bullish": ("buy", 1.0), "bearish": ("sell", -1.0), "neutral": ("neutral", 0.0)}
#: The five strategies `cli/seed_technical.py` writes are named for what they do, not for their preset.
_SEED_BIAS = {"orb 15m": "bullish", "hammer 15m near s1": "bullish", "abnormal volume": "neutral"}


@cache
def _bias_by_name() -> dict[str, str]:
    """Catalog bias by preset label and by template name (casefolded), plus the seed names."""
    found = dict(_SEED_BIAS)
    for entry in load_catalog().entries:
        if entry.kind != "strategy":
            continue
        found[entry.label.casefold()] = entry.bias
        found.setdefault(load_template(entry.file)["name"].casefold(), entry.bias)
    return found


def catalog_bias(name: str) -> str:
    """The preset's bias for a strategy named for it; `neutral` for a strategy of her own."""
    return _bias_by_name().get(name.casefold(), "neutral")


def _live_strategies(session: Session, user_id: int, today: str) -> list[tuple[Strategy, dict[str, Any]]]:
    """Attached strategies that are alert-only, not paused, not archived and not expired."""
    settings = session.execute(select(User.settings).where(User.id == user_id)).scalar_one()
    if isinstance(settings, dict) and settings.get("pause_all") is True:
        return []
    rows = session.execute(
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
    return [
        (strategy, spec)
        for strategy, spec in rows
        if status_of(strategy.stage, spec["then"]["alert"].get("expiresOn"), None, today, paused_all=False) == "active"
    ]


def strategies_gauge(
    session: Session, user_id: int, symbol: str, timeframe: str, *, now: datetime
) -> dict[str, Any] | None:
    """The gauge for `symbol` on `timeframe` as a plain dict (`StrategiesGaugeOut`), or None."""
    if symbol.startswith("/"):
        return None
    today = now.astimezone(ET).date().isoformat()
    candidates = []
    for strategy, spec in _live_strategies(session, user_id, today):
        run_on = spec["watch"]["runOn"]
        if run_on != "premarket_0830" and VOTES_ON.get(run_on) != timeframe:
            continue
        if symbol in {s for s, _ in resolve(session, user_id, spec["watch"]["universe"])}:
            candidates.append((strategy, spec))
    if not candidates:
        return None

    as_of = pd.Timestamp(now)
    intraday = any(spec["watch"]["runOn"] not in ("daily_close", "weekly") for _, spec in candidates)
    bars = StoredBars(session, [symbol], now=now, minutes=intraday)[symbol]
    frames = Frames(bars, as_of)
    votes, watching = [], []
    for strategy, spec in candidates:
        fired = False
        if spec["watch"]["runOn"] != "premarket_0830":
            try:
                outcome = evaluate_symbol(spec, symbol, frames, as_of)
                fired = outcome is not None and outcome.match is not None
            except Exception as exc:  # a condition the engine cannot run yet leaves the strategy watching
                log.debug("strategy vote: %s (%s)", strategy.name, type(exc).__name__)
        if fired:
            name_bias = catalog_bias(strategy.name)
            votes.append(
                {"strategy_id": strategy.id, "name": strategy.name, "bias": name_bias, "vote": _VOTE[name_bias][0]}
            )
        else:
            watching.append({"strategy_id": strategy.id, "name": strategy.name})

    counts = {"buy": 0, "neutral": 0, "sell": 0}
    for vote in votes:
        counts[vote["vote"]] += 1
    score = sum(_VOTE[v["bias"]][1] for v in votes) / len(votes) if votes else None
    label = bias.label(score) if score is not None and not math.isnan(score) else None
    return {
        "label": label or "warming up",
        "score": None if score is None else round(score, 3),
        "counts": counts,
        "votes": votes,
        "watching": watching,
    }
