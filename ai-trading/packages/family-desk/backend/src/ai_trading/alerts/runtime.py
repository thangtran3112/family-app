"""The alert runtime (02m §b5): the evaluation loop's rules around `core.evaluate`.

`tick` here is a drop-in for `engine.tick.tick` (same arguments, a `TickResult` subclass back), so the API's
background loop and the scheduler's jobs call it in its place. What it adds, in the order a strategy meets it:

1. **Who runs.** `alert_only` and `paper` strategies only: never a `draft`, an archived or paused one, one whose
   owner turned on "pause all", or one past its `expiresOn` (a New York date; it stops the day after).
2. **Where it looks.** The source resolves to symbols (a symbol list, a watchlist by name, or a filter's last
   matches; a filter source runs only while that last run is fresh). A future has no data yet and never runs.
3. **Never on stale data.** A `bar_close_*` strategy skips a symbol unless the `bars_delayed` feed is healthy and
   the symbol's last closed minute is no older than `max(120 s, 2 x the cadence)` plus the 15-minute provider
   delay. When data returns, only bars that closed within that window can fire: no catch-up burst.
4. **How often.** `once` (never twice for a strategy and symbol, across versions), `once_per_bar`, `every_time`;
   `limits.cooldownMinutes` compares with the strategy's latest signal on the symbol, across versions.
5. **The alert.** A signal row, then an inbox alert with its symbol and strategy, the rendered message, and one
   delivery per channel with `inbox` always first (`notify.dispatch` applies quiet hours and the channel rules).

Nothing here imports order code: a `paperOrder` in a stored spec is ignored, and the alert contract rejects it
for new strategies.
"""

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.alerts.service import status_of
from ai_trading.alerts.universe import last_filter_run, resolve
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import ET, Asset, et, previous_session
from ai_trading.core.evaluate import CADENCE_MINUTES, INTRADAY_CADENCES, SignalCandidate, evaluate
from ai_trading.core.freshness import freshness, market_session, pause_limit
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Alert, Bar1m, Delivery, FeedHealth, Signal, Strategy, StrategyVersion, User
from ai_trading.engine import degraded
from ai_trading.engine.tick import TickResult

log = logging.getLogger(__name__)

LIVE_CADENCES = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})
PROVIDER_DELAY = timedelta(minutes=15)
BARS_FEED = "bars_delayed"
DEFAULT_MESSAGE = "{symbol} {close} at {time}"
#: Minute bars read per evaluation: the widest lookback a spec uses (`rvol`'s) stays inside it. A date `end`
#: would be midnight and hide today's minutes, so every read below ends at a timestamp.
_MINUTE_LOOKBACK = timedelta(days=70)
_WEEK = timedelta(days=8)


@dataclass(frozen=True)
class RuntimeResult(TickResult):
    """`TickResult` plus what the rules skipped: symbols held back as stale and signals the frequency, cooldown
    or recency rules dropped."""

    stale_symbols: int = 0
    suppressed: int = 0
    skipped_strategies: dict[int, str] = field(default_factory=dict)


# -- pure rules ---------------------------------------------------------------------------------------------


def render_message(template: str | None, *, symbol: str, close: float | None, at: datetime) -> str:
    """The alert body: `{symbol}`, `{close}` and `{time}` (New York time as `9:45 AM`) filled into the spec's
    message, or `DEFAULT_MESSAGE`. An unknown close reads `n/a`."""
    local = at.astimezone(ET)
    clock = f"{local.hour % 12 or 12}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"
    price = "n/a" if close is None else f"{close:g}"
    return (template or DEFAULT_MESSAGE).replace("{symbol}", symbol).replace("{close}", price).replace("{time}", clock)


def cadence_interval(run_on: str) -> timedelta:
    if run_on in CADENCE_MINUTES:
        return timedelta(minutes=CADENCE_MINUTES[run_on])
    return timedelta(days=7) if run_on == "weekly" else timedelta(days=1)


def stale_limit(run_on: str, quality: str) -> timedelta:
    """How old a symbol's last closed minute may be before a `bar_close_*` strategy skips it."""
    limit = pause_limit(cadence_interval(run_on))
    return limit + PROVIDER_DELAY if quality == "delayed-15m" else limit


def recent_cutoff(run_on: str, as_of: pd.Timestamp, quality: str) -> pd.Timestamp:
    """Candidates whose bar closed before this are too old to alert on (no catch-up burst)."""
    if run_on in CADENCE_MINUTES:
        window = PROVIDER_DELAY if quality == "delayed-15m" else timedelta(0)
        return as_of - window - 2 * cadence_interval(run_on)
    today = as_of.tz_convert(ET).date()
    if run_on == "weekly":
        return as_of - _WEEK
    return et(previous_session("stock", today), "00:00")  # today's or the last session's point, never older


def bar_close(run_on: str, bar_time: pd.Timestamp) -> pd.Timestamp:
    return bar_time + cadence_interval(run_on) if run_on in CADENCE_MINUTES else bar_time


def delivery_channels(channels: list[str]) -> list[str]:
    """Inbox first, always, then the rest in order without repeats."""
    return ["inbox", *dict.fromkeys(c for c in channels if c != "inbox")]


# -- data ---------------------------------------------------------------------------------------------------


def feed_healthy(session: Session, feed: str = BARS_FEED) -> bool:
    row = session.get(FeedHealth, feed)
    return row is not None and row.state != "down" and row.last_ok_at is not None


def _last_closed_minute(session: Session, symbol: str, as_of: pd.Timestamp) -> pd.Timestamp | None:
    start = session.execute(
        select(func.max(Bar1m.bar_start)).where(
            Bar1m.symbol == symbol, Bar1m.bar_start <= (as_of - pd.Timedelta(minutes=1)).to_pydatetime()
        )
    ).scalar_one()
    return None if start is None else pd.Timestamp(start).tz_convert("UTC") + pd.Timedelta(minutes=1)


def _eval_spec(spec: dict[str, Any], symbol: str) -> StrategySpecV1:
    """The spec `evaluate` runs: this symbol as the source, and the alert-block fields this runtime applies
    itself removed, so the engine gate sees only what the engine evaluates."""
    stripped = {**spec, "watch": {**spec["watch"], "universe": {"symbols": [symbol]}}}
    alert = {k: v for k, v in spec["then"]["alert"].items() if k not in ("frequency", "expiresOn", "message")}
    stripped["then"] = {"alert": alert}
    return StrategySpecV1.model_validate(stripped)


def _close_at(
    candidate: SignalCandidate, run_on: str, bars_1m: pd.DataFrame | None, bars_1d: pd.DataFrame
) -> float | None:
    """The close shown as `{close}`: the `close` operand when the condition used one, else the closing price of
    the bar the signal is about, from the bars already read."""
    if "close" in candidate.evidence:
        return candidate.evidence["close"]
    if run_on in CADENCE_MINUTES and bars_1m is not None and not bars_1m.empty:
        last_minute = candidate.bar_time + cadence_interval(run_on) - pd.Timedelta(minutes=1)
        found = bars_1m.loc[:last_minute]
        return None if found.empty else float(found["close"].iloc[-1])
    if run_on == "premarket_0830" and bars_1m is not None and not bars_1m.empty:
        found = bars_1m.loc[: candidate.bar_time - pd.Timedelta(minutes=1)]
        return None if found.empty else float(found["close"].iloc[-1])
    day: date = candidate.bar_time.tz_convert(ET).date()
    return float(bars_1d.loc[day, "close"]) if day in bars_1d.index else None


def _signals(session: Session, strategy_id: int, symbol: str) -> list[datetime]:
    """Every bar time this strategy has signalled on `symbol`, across versions, oldest first."""
    return list(
        session.execute(
            select(Signal.bar_time)
            .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
            .where(StrategyVersion.strategy_id == strategy_id, Signal.symbol == symbol)
            .order_by(Signal.bar_time)
        ).scalars()
    )


def _allowed(candidate_time: pd.Timestamp, history: list[pd.Timestamp], frequency: str, cooldown: int | None) -> bool:
    """The frequency and cooldown rules against the bar times already signalled (any version)."""
    if frequency == "once" and history:
        return False
    if candidate_time in history:  # the same bar under another version
        return False
    if cooldown and history and candidate_time < history[-1] + pd.Timedelta(minutes=cooldown):
        return False
    return True


# -- the loop -----------------------------------------------------------------------------------------------


def _live_strategies(session: Session) -> list[tuple[Strategy, StrategyVersion]]:
    rows = session.execute(
        select(Strategy, StrategyVersion)
        .join(StrategyVersion, StrategyVersion.id == Strategy.current_version_id)
        .where(
            Strategy.stage.in_(("alert_only", "paper")),
            Strategy.archived_at.is_(None),
            Strategy.paused_reason.is_(None),
        )
        .order_by(Strategy.id)
    ).all()
    return [(strategy, version) for strategy, version in rows]


def _paused_owners(session: Session) -> set[int]:
    rows = session.execute(select(User.id, User.settings)).all()
    return {user_id for user_id, settings in rows if isinstance(settings, dict) and settings.get("pause_all") is True}


def _symbols(session: Session, owner_id: int, spec: dict[str, Any], as_of: pd.Timestamp) -> list[tuple[str, Asset]]:
    """The strategy's `(symbol, asset)` pairs; a filter source needs a run fresh enough to trust."""
    universe = spec["watch"]["universe"]
    if "filter" in universe:
        run = last_filter_run(session, owner_id, universe["filter"])
        today = as_of.tz_convert(ET).date()
        newest_ok = previous_session("stock", today)
        if run is None or run.evaluation_point.astimezone(ET).date() < newest_ok:
            return []
    return [
        (symbol, "future" if asset == "future" else "stock") for symbol, asset in resolve(session, owner_id, universe)
    ]


def tick(session: Session, *, now: datetime, live_cadences: frozenset[str] = LIVE_CADENCES) -> RuntimeResult:
    """Evaluate every live strategy whose cadence is in `live_cadences` as of `now`. Commits once at the end."""
    as_of = pd.Timestamp(now).tz_convert("UTC")
    today = as_of.tz_convert(ET).date().isoformat()
    evaluated = new_signals = stale = suppressed = 0
    errors: list[str] = []
    skipped: dict[int, str] = {}
    paused_owners = _paused_owners(session)
    healthy = feed_healthy(session)

    for strategy, version in _live_strategies(session):
        if strategy.owner_user_id in paused_owners:
            skipped[strategy.id] = "paused by the owner"
            continue
        spec = version.spec
        run_on = spec["watch"]["runOn"]
        if run_on not in live_cadences:
            continue
        alert = spec["then"]["alert"]
        if status_of(strategy.stage, alert.get("expiresOn"), None, today, paused_all=False) == "expired":
            skipped[strategy.id] = "expired"
            continue
        live_data = run_on in CADENCE_MINUTES
        for symbol, asset in _symbols(session, strategy.owner_user_id, spec, as_of):
            quality = degraded.quality_for(asset, run_on)
            if quality == "unavailable":
                continue  # a future has no data source until the IBKR slot is live
            if live_data:
                last = _last_closed_minute(session, symbol, as_of)
                if not healthy or last is None or as_of - last > stale_limit(run_on, quality):
                    stale += 1
                    continue
            evaluated += 1
            try:
                fired = _evaluate_symbol(session, strategy, version, spec, symbol, asset, quality, as_of, now)
            except ValueError as exc:
                errors.append(f"{strategy.name} {symbol}: {exc}")
                continue
            new_signals += fired[0]
            suppressed += fired[1]

    session.commit()
    return RuntimeResult(
        evaluated_strategies=evaluated,
        new_signals=new_signals,
        errors=errors,
        stale_symbols=stale,
        suppressed=suppressed,
        skipped_strategies=skipped,
    )


def _evaluate_symbol(
    session: Session,
    strategy: Strategy,
    version: StrategyVersion,
    spec: dict[str, Any],
    symbol: str,
    asset: Asset,
    quality: str,
    as_of: pd.Timestamp,
    now: datetime,
) -> tuple[int, int]:
    """`(new signals, dropped candidates)` for one symbol."""
    run_on = spec["watch"]["runOn"]
    alert = spec["then"]["alert"]
    bars_1d = read_bars(session, symbol, "1d", ALPACA_FREE_HISTORY_START, as_of.date(), asset, as_of=as_of)
    bars_1m = None
    if run_on in INTRADAY_CADENCES:
        bars_1m = read_bars(session, symbol, "1m", as_of - _MINUTE_LOOKBACK, as_of, asset, as_of=as_of)
    candidates = evaluate(_eval_spec(spec, symbol), symbol, asset, bars_1m=bars_1m, bars_1d=bars_1d, as_of=as_of)

    cutoff = recent_cutoff(run_on, as_of, quality)
    history = [pd.Timestamp(t).tz_convert("UTC") for t in _signals(session, strategy.id, symbol)]
    frequency = alert.get("frequency", "once_per_bar")
    cooldown = spec.get("limits", {}).get("cooldownMinutes")
    channels = delivery_channels(alert["channels"])
    written = dropped = 0
    for candidate in candidates:
        if bar_close(run_on, candidate.bar_time) < cutoff:
            continue  # older than the recent window: a missed bar, not an alert
        if not _allowed(candidate.bar_time, history, frequency, cooldown):
            dropped += 1
            continue
        if _record(session, strategy, version, spec, candidate, quality, channels, bars_1m, bars_1d, now):
            history.append(candidate.bar_time)
            written += 1
    return written, dropped


def _record(
    session: Session,
    strategy: Strategy,
    version: StrategyVersion,
    spec: dict[str, Any],
    candidate: SignalCandidate,
    quality: str,
    channels: list[str],
    bars_1m: pd.DataFrame | None,
    bars_1d: pd.DataFrame,
    now: datetime,
) -> bool:
    """Signal, alert and deliveries in one transaction; False when the signal row already exists."""
    run_on = spec["watch"]["runOn"]
    alert = spec["then"]["alert"]
    stmt = (
        pg_insert(Signal)
        .values(
            strategy_version_id=version.id,
            symbol=candidate.symbol,
            bar_time=candidate.bar_time,
            evidence=candidate.evidence,
            data_quality=quality,
            created_at=now,
        )
        .on_conflict_do_nothing(index_elements=["strategy_version_id", "symbol", "bar_time"])
        .returning(Signal.id)
    )
    signal_id = session.execute(stmt).scalar_one_or_none()
    if signal_id is None:
        return False
    fired_at = bar_close(run_on, candidate.bar_time).to_pydatetime()
    body = render_message(
        alert.get("message"),
        symbol=candidate.symbol,
        close=_close_at(candidate, run_on, bars_1m, bars_1d),
        at=fired_at,
    )
    row = Alert(
        user_id=strategy.owner_user_id,
        signal_id=signal_id,
        kind="signal",
        severity=alert.get("severity") or "info",
        title=f"{candidate.symbol}: {strategy.name}",
        body=body,
        payload={"strategy": strategy.name, "bar_time": candidate.bar_time.isoformat(), "evidence": candidate.evidence},
        created_at=now,
        symbol=candidate.symbol,
        strategy_id=strategy.id,
    )
    session.add(row)
    session.flush()
    for channel in channels:
        session.add(Delivery(alert_id=row.id, channel=channel))
    return True


# -- state for /status --------------------------------------------------------------------------------------


def alert_state(session: Session, user_id: int, now: datetime) -> str:
    """`/status.alerts.state` (02m §a3.1): `paused_by_user`, `not_started` (no live strategy), `paused_no_quotes`
    (a session is open and the bars feed has stopped or never ran), else `running`."""
    settings = session.execute(select(User.settings).where(User.id == user_id)).scalar_one()
    if isinstance(settings, dict) and settings.get("pause_all") is True:
        return "paused_by_user"
    live = session.execute(
        select(func.count())
        .select_from(Strategy)
        .where(
            Strategy.owner_user_id == user_id,
            Strategy.stage.in_(("alert_only", "paper")),
            Strategy.archived_at.is_(None),
            Strategy.paused_reason.is_(None),
        )
    ).scalar_one()
    if not live:
        return "not_started"
    row = session.get(FeedHealth, BARS_FEED)
    last_ok = None if row is None else row.last_ok_at
    stamp = freshness("delayed-15m", market_session(now), last_ok, now, timedelta(minutes=15))
    return "paused_no_quotes" if stamp in ("paused", "unavailable") else "running"
