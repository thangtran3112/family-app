"""Seed the technical desktop MVP for one user (02m §b6): `python -m ai_trading.cli.seed_technical --email ...`.

Idempotent per user: every row is looked up by its natural key first, and a second run adds nothing
and changes nothing (a watchlist the user already reordered keeps her order). Not a migration: it
runs after a user exists, from the `api` or `scheduler` image, with the runtime database role.

Seeds are drafts. The runtime moves a strategy to `alert_only` only when `alerts_runtime_enabled`
is on (02m §b5 item 6), so nothing here can send an alert.
"""

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.db.engine import make_engine, make_session_factory, session_scope
from ai_trading.db.models import (
    Strategy,
    StrategyVersion,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.library.catalog import alert_only_spec, load_template
from ai_trading.screener.service import ensure_seed_filters

DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"

SEED_WATCHLISTS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Day movers", "intraday", ("NVDA", "AMD", "TSLA", "PLTR", "META", "AAPL", "AVGO", "COIN")),
    ("Swing", "swing", ("MSFT", "AMZN", "GOOGL", "CRWD", "SHOP", "UBER")),
)
_DAY_MOVERS = "Day movers"


@dataclass
class SeedReport:
    watchlists: int = 0
    watchlist_items: int = 0
    filters: int = 0
    alert_strategies: int = 0

    @property
    def total(self) -> int:
        return self.watchlists + self.watchlist_items + self.filters + self.alert_strategies


def seed_alert_specs() -> list[AlertStrategySpecV1]:
    """Her starting alert strategies (02l §e3), all alert-only on Day movers."""
    hammer = load_template("patterns/hammer.json")
    # "near S1": the hammer's low is within 0.5% of the classic session S1 pivot.
    hammer["when"] = {
        "all": [
            hammer["when"],
            {
                "op": "within_pct",
                "left": {"series": "low"},
                "right": {"level": "pivot", "method": "classic", "period": "session", "point": "S1"},
                "pct": 0.5,
            },
        ]
    }
    abnormal_volume = {
        "schemaVersion": 1,
        "name": "Abnormal volume",
        "watch": {"universe": {"watchlist": _DAY_MOVERS}, "session": "regular", "runOn": "bar_close_15m"},
        "when": {"op": "gte", "left": {"series": "rvol", "lookbackDays": 10}, "right": {"value": 2.5}},
        "then": {"alert": {"channels": ["inbox", "telegram"], "severity": "opportunity"}},
        "limits": {"cooldownMinutes": 60},
    }
    return [
        alert_only_spec(load_template("orb-breakout.json"), name="ORB 15m", watchlist=_DAY_MOVERS),
        alert_only_spec(load_template("vwap-reclaim.json"), name="VWAP reclaim", watchlist=_DAY_MOVERS),
        alert_only_spec(hammer, name="Hammer 15m near S1", watchlist=_DAY_MOVERS, channels=["inbox", "telegram"]),
        alert_only_spec(abnormal_volume, watchlist=_DAY_MOVERS),
        alert_only_spec(load_template("setups/hod-break.json"), name="High-of-day break", watchlist=_DAY_MOVERS),
    ]


def _dump(spec: Any) -> dict[str, Any]:
    return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


def _seed_watchlists(session: Session, user_id: int, report: SeedReport) -> None:
    for name, horizon, symbols in SEED_WATCHLISTS:
        watchlist = session.execute(
            select(Watchlist).where(Watchlist.user_id == user_id, Watchlist.name == name)
        ).scalar_one_or_none()
        if watchlist is None:
            watchlist = Watchlist(user_id=user_id, name=name, horizon=horizon)
            session.add(watchlist)
            session.flush()
            report.watchlists += 1
        have = set(
            session.execute(select(WatchlistItem.symbol).where(WatchlistItem.watchlist_id == watchlist.id)).scalars()
        )
        for position, symbol in enumerate(symbols):
            if symbol not in have:
                session.add(
                    WatchlistItem(watchlist_id=watchlist.id, symbol=symbol, asset_type="stock", position=position)
                )
                report.watchlist_items += 1


def _seed_filters(session: Session, user_id: int, now: datetime, report: SeedReport) -> None:
    report.filters += ensure_seed_filters(session, user_id, now=now)


def _seed_alert_strategies(session: Session, user_id: int, now: datetime, report: SeedReport) -> None:
    have = set(
        session.execute(
            select(Strategy.name).where(Strategy.owner_user_id == user_id, Strategy.origin == "seed")
        ).scalars()
    )
    for spec in seed_alert_specs():
        if spec.name in have:
            continue
        row = Strategy(
            owner_user_id=user_id, name=spec.name, stage="draft", lane="technical", origin="seed", created_at=now
        )
        session.add(row)
        session.flush()
        version = StrategyVersion(
            strategy_id=row.id,
            version=1,
            schema_version=spec.schemaVersion,
            spec=_dump(spec),
            change_note="seeded",
            created_by=user_id,
            created_at=now,
        )
        session.add(version)
        session.flush()
        row.current_version_id = version.id
        report.alert_strategies += 1


def seed_user(session: Session, user_id: int, *, now: datetime | None = None) -> SeedReport:
    """Seed one existing user. Caller commits. A second call returns a zero report."""
    now = now or datetime.now(UTC)
    report = SeedReport()
    _seed_watchlists(session, user_id, report)
    _seed_filters(session, user_id, now, report)
    _seed_alert_strategies(session, user_id, now, report)
    return report


def seed_email(session: Session, email: str, *, now: datetime | None = None) -> SeedReport:
    """Find or create the user (the API creates users lazily on first request), then seed."""
    user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        user = User(email=email, settings={})
        session.add(user)
        session.flush()
    return seed_user(session, user.id, now=now)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the technical desktop MVP for one user (idempotent).")
    parser.add_argument("--email", required=True, help="the user's verified email, as the gateway sends it")
    args = parser.parse_args(argv)
    url = os.environ.get(DATABASE_URL_VAR)
    if not url:
        print(f"{DATABASE_URL_VAR} is not set", file=sys.stderr)
        return 2
    with session_scope(make_session_factory(make_engine(url))) as session:
        report = seed_email(session, args.email)
    # Counts only: the public repo's logs must not carry the email.
    print(
        f"seeded watchlists={report.watchlists} items={report.watchlist_items} "
        f"filters={report.filters} alert_strategies={report.alert_strategies}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
