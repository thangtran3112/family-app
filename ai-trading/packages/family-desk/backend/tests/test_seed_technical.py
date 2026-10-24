"""`cli/seed_technical.py` (02m §b6): the seed set, and that a second run changes nothing."""

from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ai_trading.cli.seed_technical import seed_alert_specs, seed_email
from ai_trading.contracts.alert_strategy import AlertStrategySpecV1
from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.db.models import (
    FilterStrategy,
    FilterStrategyVersion,
    Strategy,
    StrategyVersion,
    User,
    Watchlist,
    WatchlistItem,
)
from ai_trading.library.catalog import load_catalog

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)
EMAIL = "seed-owner@example.test"


def _count(session: Session, model) -> int:
    return session.execute(select(func.count()).select_from(model)).scalar_one()


def test_seed_creates_the_documented_set(db_session: Session) -> None:
    report = seed_email(db_session, EMAIL, now=NOW)
    db_session.commit()

    assert (report.watchlists, report.watchlist_items, report.filters, report.alert_strategies) == (2, 14, 10, 5)
    lists = {w.name: w for w in db_session.execute(select(Watchlist)).scalars()}
    assert lists["Day movers"].horizon == "intraday" and lists["Swing"].horizon == "swing"
    day_movers = db_session.execute(
        select(WatchlistItem.symbol)
        .where(WatchlistItem.watchlist_id == lists["Day movers"].id)
        .order_by(WatchlistItem.position)
    ).scalars()
    assert list(day_movers) == ["NVDA", "AMD", "TSLA", "PLTR", "META", "AAPL", "AVGO", "COIN"]


def test_seed_filters_are_read_only_seed_copies_of_the_ten_templates(db_session: Session) -> None:
    seed_email(db_session, EMAIL, now=NOW)
    db_session.commit()

    filters = db_session.execute(select(FilterStrategy).order_by(FilterStrategy.id)).scalars().all()
    assert {f.origin for f in filters} == {"seed"}
    assert {f.seed_key for f in filters} == {e.id for e in load_catalog().entries if e.kind == "filter"}
    assert all(f.archived_at is None for f in filters)
    for row in filters:
        version = db_session.get(FilterStrategyVersion, row.current_version_id)
        assert version is not None and version.filter_strategy_id == row.id and version.version == 1
        FilterStrategySpecV1.model_validate(version.spec)


def test_seed_alert_strategies_are_drafts_and_alert_only(db_session: Session) -> None:
    seed_email(db_session, EMAIL, now=NOW)
    db_session.commit()

    rows = db_session.execute(select(Strategy).order_by(Strategy.id)).scalars().all()
    assert [r.name for r in rows] == [
        "ORB 15m",
        "VWAP reclaim",
        "Hammer 15m near S1",
        "Abnormal volume",
        "High-of-day break",
    ]
    for row in rows:
        assert (row.stage, row.origin, row.lane, row.paused_reason) == ("draft", "seed", "technical", None)
        version = db_session.get(StrategyVersion, row.current_version_id)
        spec = AlertStrategySpecV1.model_validate(version.spec)
        assert spec.watch.universe.watchlist == "Day movers"
        assert "paperOrder" not in version.spec["then"]
        assert spec.then.alert.channels[0] == "inbox"


def test_seed_alert_specs_have_no_order_fields() -> None:
    for spec in seed_alert_specs():
        dumped = spec.model_dump(by_alias=True, exclude_none=True)
        assert "paperOrder" not in dumped["then"]
        assert set(dumped.get("limits", {})) <= {"cooldownMinutes"}


def test_second_run_adds_nothing_and_keeps_her_changes(db_session: Session) -> None:
    seed_email(db_session, EMAIL, now=NOW)
    db_session.commit()
    day_movers = db_session.execute(select(Watchlist).where(Watchlist.name == "Day movers")).scalar_one()
    db_session.execute(
        update(WatchlistItem)
        .where(WatchlistItem.watchlist_id == day_movers.id, WatchlistItem.symbol == "COIN")
        .values(position=0)
    )
    db_session.commit()
    before = {
        m: _count(db_session, m) for m in (Watchlist, WatchlistItem, FilterStrategy, Strategy, StrategyVersion, User)
    }

    again = seed_email(db_session, EMAIL, now=NOW)
    db_session.commit()

    assert again.total == 0
    assert before == {m: _count(db_session, m) for m in before}
    coin = db_session.get(WatchlistItem, (day_movers.id, "COIN"))
    assert coin.position == 0


def test_second_user_gets_their_own_copies(db_session: Session) -> None:
    seed_email(db_session, EMAIL, now=NOW)
    seed_email(db_session, "seed-other@example.test", now=NOW)
    db_session.commit()

    assert _count(db_session, User) == 2
    assert _count(db_session, Watchlist) == 4
    assert _count(db_session, FilterStrategy) == 20
    assert _count(db_session, Strategy) == 10
