"""Alert-strategy CRUD on top of `strategies` and `strategy_versions` (02m §b1 `alerts/service.py`).

An alert strategy is a `Strategy` row of lane `technical` whose versions hold an `AlertStrategySpecV1`. The
derived fields the API shows (`status`, `category`, `source`, `last_fired_at`, `fires_7d`) are computed here,
not stored. Every function is scoped to its owner: another user's strategy is `StrategyNotFound`, the same as a
missing id. Callers (the routes, the library attach, the seed CLI) commit.
"""

from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.alerts import describe
from ai_trading.alerts.universe import resolve, source_label
from ai_trading.core.calendar import ET, annotate
from ai_trading.core.evaluate import _resample
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Alert, Delivery, Signal, Strategy, StrategyVersion, User
from ai_trading.runtime_flags import alerts_runtime_enabled

FIRES_WINDOW = timedelta(days=7)
THUMB_BARS = 40
_THUMB_SESSIONS = 5  # calendar days of minutes read for a thumbnail: enough for 40 15-minute bars
STATUS_ORDER = {"active": 0, "paused": 1, "draft": 2, "expired": 3}


class StrategyNotFound(Exception):
    """No such alert strategy for this user (missing, archived, or someone else's)."""


class RuntimeDisabled(Exception):
    """Moving a strategy to `alert_only` is off until `DESK_ALERTS_RUNTIME_ENABLED=1`."""


@dataclass(frozen=True)
class StrategyView:
    row: Strategy
    version: StrategyVersion
    paused_by_user: bool = False  # the owner's "pause all" is on

    @property
    def spec(self) -> dict[str, Any]:
        return self.version.spec

    @property
    def alert(self) -> dict[str, Any]:
        return self.spec["then"]["alert"]


def status_of(stage: str, expires_on: str | None, paused_reason: str | None, today: str, *, paused_all: bool) -> str:
    """`draft` (stage draft), `expired` (`expires_on` passed), `paused` (a pause reason, including the owner's
    pause-all), else `active`. `today` is the New York date as `YYYY-MM-DD`."""
    if stage == "draft":
        return "draft"
    if expires_on is not None and expires_on < today:
        return "expired"
    return "paused" if (paused_reason or paused_all) else "active"


def _today(now: datetime) -> str:
    return now.astimezone(ET).date().isoformat()


def _pause_all(session: Session, user_id: int) -> bool:
    settings = session.execute(select(User.settings).where(User.id == user_id)).scalar_one()
    return isinstance(settings, dict) and settings.get("pause_all") is True


def _view(session: Session, strategy_id: int, user_id: int) -> StrategyView:
    row = session.get(Strategy, strategy_id)
    if (
        row is None
        or row.owner_user_id != user_id
        or row.archived_at is not None
        or row.lane != "technical"
        or row.current_version_id is None
    ):
        raise StrategyNotFound(strategy_id)
    return StrategyView(row, session.get(StrategyVersion, row.current_version_id), _pause_all(session, user_id))


def get_strategy(session: Session, user_id: int, strategy_id: int) -> StrategyView:
    return _view(session, strategy_id, user_id)


def _fire_stats(session: Session, strategy_ids: Collection[int], now: datetime) -> dict[int, tuple[datetime, int]]:
    """`strategy_id -> (last bar_time, fires in the last 7 days)` over every version of each strategy."""
    if not strategy_ids:
        return {}
    cutoff = now - FIRES_WINDOW
    rows = session.execute(
        select(
            StrategyVersion.strategy_id,
            func.max(Signal.bar_time),
            func.count().filter(Signal.bar_time >= cutoff),
        )
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(StrategyVersion.strategy_id.in_(strategy_ids))
        .group_by(StrategyVersion.strategy_id)
    ).all()
    return {strategy_id: (last, count) for strategy_id, last, count in rows}


def strategy_out(session: Session, user_id: int, views: Iterable[StrategyView], now: datetime) -> list[dict[str, Any]]:
    """`AlertStrategyOut` dicts for `views`, one stats query for all of them."""
    views = list(views)
    stats = _fire_stats(session, [view.row.id for view in views], now)
    today = _today(now)
    out = []
    for view in views:
        spec, alert = view.spec, view.alert
        expires_on = alert.get("expiresOn")
        last, count = stats.get(view.row.id, (None, 0))
        out.append(
            {
                "id": view.row.id,
                "name": view.row.name,
                "origin": view.row.origin if view.row.origin in ("seed", "library") else "user",
                "stage": view.row.stage,
                "status": status_of(
                    view.row.stage, expires_on, view.row.paused_reason, today, paused_all=view.paused_by_user
                ),
                "paused_reason": view.row.paused_reason,
                "version": view.version.version,
                "source": source_label(session, user_id, spec["watch"]["universe"]),
                "category": describe.category(spec),
                "run_on": spec["watch"]["runOn"],
                "frequency": alert.get("frequency", "once_per_bar"),
                "cooldown_minutes": spec.get("limits", {}).get("cooldownMinutes"),
                "expires_on": expires_on,
                "channels": alert["channels"],
                "severity": alert.get("severity", "info"),
                "last_fired_at": last,
                "fires_7d": count,
                "spec": spec,
            }
        )
    return out


def list_strategies(
    session: Session,
    user_id: int,
    *,
    now: datetime,
    status: str | None = None,
    category: str | None = None,
    symbol: str | None = None,
    watchlist_id: int | None = None,
    sort: str = "name",
) -> list[dict[str, Any]]:
    rows = session.execute(
        select(Strategy, StrategyVersion)
        .join(StrategyVersion, StrategyVersion.id == Strategy.current_version_id)
        .where(Strategy.owner_user_id == user_id, Strategy.archived_at.is_(None), Strategy.lane == "technical")
    ).all()
    paused_all = _pause_all(session, user_id)
    out = strategy_out(session, user_id, [StrategyView(row, version, paused_all) for row, version in rows], now)
    if status is not None:
        out = [item for item in out if item["status"] == status]
    if category is not None:
        out = [item for item in out if item["category"] == category]
    if watchlist_id is not None:
        out = [item for item in out if item["source"]["kind"] == "watchlist" and item["source"]["id"] == watchlist_id]
    if symbol is not None:
        out = [
            item
            for item in out
            if symbol in {s for s, _ in resolve(session, user_id, item["spec"]["watch"]["universe"])}
        ]
    if sort == "last_fired":
        out.sort(key=lambda item: (item["last_fired_at"] is None, -(item["last_fired_at"] or now).timestamp()))
    elif sort == "status":
        out.sort(key=lambda item: (STATUS_ORDER[item["status"]], item["name"].casefold()))
    else:
        out.sort(key=lambda item: item["name"].casefold())
    return out


def versions_out(session: Session, strategy_id: int) -> list[dict[str, Any]]:
    rows = session.execute(
        select(StrategyVersion).where(StrategyVersion.strategy_id == strategy_id).order_by(StrategyVersion.version)
    ).scalars()
    return [{"version": v.version, "created_at": v.created_at, "change_note": v.change_note} for v in rows]


def _stage_for(save_as: str) -> str:
    if save_as == "on":
        if not alerts_runtime_enabled():
            raise RuntimeDisabled()
        return "alert_only"
    return "draft"


def create_strategy(
    session: Session,
    user_id: int,
    spec: dict[str, Any],
    *,
    save_as: str,
    origin: str = "user",
    note: str = "created",
    now: datetime,
) -> StrategyView:
    stage = _stage_for(save_as)
    row = Strategy(
        owner_user_id=user_id, name=spec["name"], stage=stage, lane="technical", origin=origin, created_at=now
    )
    session.add(row)
    session.flush()
    version = StrategyVersion(
        strategy_id=row.id,
        version=1,
        schema_version=spec["schemaVersion"],
        spec=spec,
        change_note=note,
        created_by=user_id,
        created_at=now,
    )
    session.add(version)
    session.flush()
    row.current_version_id = version.id
    return StrategyView(row, version, _pause_all(session, user_id))


def revise_strategy(
    session: Session, user_id: int, strategy_id: int, spec: dict[str, Any], change_note: str | None, *, now: datetime
) -> StrategyView:
    """The next version of the spec. An unchanged spec is not a new version. The name follows the spec."""
    view = _view(session, strategy_id, user_id)
    if spec == view.spec:
        return view
    last = session.execute(
        select(func.max(StrategyVersion.version)).where(StrategyVersion.strategy_id == strategy_id)
    ).scalar_one()
    version = StrategyVersion(
        strategy_id=strategy_id,
        version=last + 1,
        schema_version=spec["schemaVersion"],
        spec=spec,
        change_note=change_note,
        created_by=user_id,
        created_at=now,
    )
    session.add(version)
    session.flush()
    view.row.name = spec["name"]
    view.row.current_version_id = version.id
    return StrategyView(view.row, version, view.paused_by_user)


def archive_strategy(session: Session, user_id: int, strategy_id: int, *, now: datetime) -> None:
    """Hide the strategy from lists and stop it evaluating; its versions and signals stay (RESTRICT FKs)."""
    view = _view(session, strategy_id, user_id)
    view.row.archived_at = now
    view.row.paused_reason = view.row.paused_reason or "archived"


def pause_strategy(session: Session, user_id: int, strategy_id: int, reason: str) -> StrategyView:
    view = _view(session, strategy_id, user_id)
    view.row.paused_reason = reason
    return view


def resume_strategy(session: Session, user_id: int, strategy_id: int) -> StrategyView:
    """Clear the pause. A draft moves to `alert_only` (the `Turn on` control) only with the runtime flag on."""
    view = _view(session, strategy_id, user_id)
    if view.row.stage == "draft":
        if not alerts_runtime_enabled():
            raise RuntimeDisabled()
        view.row.stage = "alert_only"
    view.row.paused_reason = None
    return view


def find_library_strategy(session: Session, user_id: int, name: str, watchlist: str) -> StrategyView | None:
    """The user's live strategy a preset attach already wrote for this watchlist (the idempotency key)."""
    candidates = session.execute(
        select(Strategy.id).where(
            Strategy.owner_user_id == user_id,
            Strategy.origin == "library",
            Strategy.archived_at.is_(None),
            Strategy.name == name,
        )
    ).scalars()
    for strategy_id in candidates:
        view = _view(session, strategy_id, user_id)
        if view.spec["watch"]["universe"].get("watchlist") == watchlist:
            return view
    return None


# -- fires ------------------------------------------------------------------------------------------------


def delivery_log_status(status: str, channel: str, wired: Collection[str]) -> str | None:
    """A delivery's log status (02m §a3.7), or None for one still on its way. `skipped_preferences`, `no_channel`
    and a `pending` row on a channel nothing is wired for read `no_channel`."""
    if status == "sent":
        return "delivered"
    if status == "skipped_quiet_hours":
        return "held_quiet_hours"
    if status in ("skipped_preferences", "no_channel"):
        return "no_channel"
    if status == "failed":
        return "failed"
    if status == "pending" and channel not in wired:
        return "no_channel"
    return None


def fires(session: Session, user_id: int, strategy_id: int, limit: int, wired: Collection[str]) -> list[dict[str, Any]]:
    """The strategy's signals across versions, newest first, with their deliveries and a 15-minute thumbnail."""
    _view(session, strategy_id, user_id)
    rows = session.execute(
        select(Signal)
        .join(StrategyVersion, StrategyVersion.id == Signal.strategy_version_id)
        .where(StrategyVersion.strategy_id == strategy_id)
        .order_by(Signal.bar_time.desc(), Signal.id.desc())
        .limit(limit)
    ).scalars()
    out = []
    for signal in rows:
        deliveries = session.execute(
            select(Delivery.channel, Delivery.status)
            .join(Alert, Alert.id == Delivery.alert_id)
            .where(Alert.signal_id == signal.id)
            .order_by(Delivery.id)
        ).all()
        mapped = [(channel, delivery_log_status(status, channel, wired)) for channel, status in deliveries]
        out.append(
            {
                "signal_id": signal.id,
                "symbol": signal.symbol,
                "bar_time": signal.bar_time,
                "evidence": signal.evidence,
                "deliveries": [{"channel": c, "status": s} for c, s in mapped if s is not None],
                "thumb": {"interval": "15m", "bars": thumb(session, signal.symbol, signal.bar_time)},
            }
        )
    return out


def _bar_row(point: pd.Timestamp, row: pd.Series) -> dict[str, Any]:
    return {
        "t": point.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "o": float(row["open"]),
        "h": float(row["high"]),
        "l": float(row["low"]),
        "c": float(row["close"]),
        "v": float(row["volume"]),
    }


def thumb(session: Session, symbol: str, bar_time: datetime) -> list[dict[str, Any]]:
    """Up to 40 closed 15-minute bars ending with the one that holds `bar_time`, from the stored minutes. A
    symbol with no stored minutes (or a futures root) has no thumbnail."""
    if symbol.startswith("/"):
        return []
    end = pd.Timestamp(bar_time).tz_convert("UTC") + pd.Timedelta(hours=1)
    # Timestamps, not dates: a date `end` is midnight and would hide that day's minutes.
    minutes = read_bars(session, symbol, "1m", end - pd.Timedelta(days=_THUMB_SESSIONS), end, "stock", as_of=end)
    if minutes.empty:
        return []
    bars = _resample(annotate(minutes, "stock"), "stock", 15, end)
    bars = bars[bars.index <= pd.Timestamp(bar_time).tz_convert("UTC")].tail(THUMB_BARS)
    return [_bar_row(point, row) for point, row in bars.iterrows()]
