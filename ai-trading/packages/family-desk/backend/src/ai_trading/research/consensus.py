"""The daily consensus snapshot (02n §d `research/consensus.py`, 02f §4): per watchlist symbol, the consensus EPS by
fiscal period, the reported-vs-estimated results, and the analyst targets, stored as dated rows so the 7/30/90-day
revisions can be read from the Desk's own history with any source.

Every provider call goes through `DataSources` (`consensus`, `earnings`, `targets`: Eulerpool first, the free
fallbacks behind it, 02j). Three feeds, one pass each, written to `feed_health` like `data/refresher.py`:

- `consensus`  -> `consensus_snapshots`, one row per symbol, fiscal period, and ET day;
- `earnings`   -> `earnings_results`, one row per symbol and fiscal period (latest answer);
- `targets`    -> `analyst_targets`, one row per symbol and ET day.

One symbol's failure is recorded and the pass goes on; five failures in a row stop that feed's pass (the provider
is down or has banned us). A feed that already finished today (`feed_health.last_ok_at` on today's ET date) is not
fetched again, so a scheduler restart or a retry for another feed costs no provider calls. Rows are upserted on
their key, so a repeat run on the same day changes nothing but the capture time. Failures keep the error class
only: provider messages can carry a request URL.
"""

from collections.abc import Callable
from dataclasses import fields
from datetime import date, datetime
from typing import Any

import pandas as pd
from ai_trading_common.registry import DataSources
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET
from ai_trading.data.refresher import PassReport, _detail, _fetch_each, record_health, watchlist_symbols
from ai_trading.db.models import AnalystTarget, Base, ConsensusSnapshot, EarningsResult, FeedHealth
from ai_trading.holdings.service import held_symbols

CONSENSUS_FEED = "consensus"
EARNINGS_FEED = "earnings"
TARGETS_FEED = "targets"
FEEDS = (CONSENSUS_FEED, EARNINGS_FEED, TARGETS_FEED)


def snapshot_symbols(session: Session) -> list[str]:
    """The symbols to snapshot: every stock on a watchlist and every stock a holdings import has put in an account."""
    return sorted({*watchlist_symbols(session), *held_symbols(session)})


def done_today(session: Session, feed: str, day: date) -> bool:
    """True when `feed` last finished (ok or degraded) on the ET date `day`."""
    row = session.get(FeedHealth, feed, populate_existing=True)
    return row is not None and row.last_ok_at is not None and row.last_ok_at.astimezone(ET).date() == day


def _row(item: object, **extra: Any) -> dict[str, Any]:
    """A provider record as a table row: its fields as they are, `as_of` as a UTC datetime."""
    row = {field.name: getattr(item, field.name) for field in fields(item)} | extra
    as_of = pd.Timestamp(row["as_of"])
    row["as_of"] = (as_of.tz_localize("UTC") if as_of.tzinfo is None else as_of).to_pydatetime()
    return row


def _upsert(session: Session, model: type[Base], rows: list[dict[str, Any]]) -> None:
    """Insert `rows`, replacing a row with the same primary key (the last of two equal keys wins)."""
    if not rows:
        return
    keys = [column.name for column in model.__table__.primary_key.columns]
    unique = {tuple(row[key] for key in keys): row for row in rows}
    stmt = pg_insert(model).values(list(unique.values()))
    changed = {column.name: stmt.excluded[column.name] for column in model.__table__.columns if column.name not in keys}
    session.execute(stmt.on_conflict_do_update(index_elements=keys, set_=changed))


def snapshot_pass(session: Session, sources: DataSources, *, now: datetime) -> dict[str, PassReport]:
    """Fetch and store today's snapshot for every feed that has not finished today. Caller commits.

    Returns one report per feed that ran. A feed whose report is `down` fetched nothing and stays unfinished, so
    the next call retries it (and only it)."""
    stamp = pd.Timestamp(now)
    day = stamp.tz_convert(ET).date()

    def consensus(symbol: str) -> None:
        items = sources.consensus.consensus(symbol, now=stamp)
        _upsert(session, ConsensusSnapshot, [_row(item, snapshot_date=day, captured_at=now) for item in items])

    def earnings(symbol: str) -> None:
        items = sources.earnings.earnings_results(symbol, now=stamp)
        # A calendar row the provider never joined to a fiscal period has no key to be stored under.
        _upsert(session, EarningsResult, [_row(i, captured_at=now) for i in items if i.period_end is not None])

    def targets(symbol: str) -> None:
        item = sources.targets.analyst_targets(symbol, now=stamp)
        _upsert(session, AnalystTarget, [_row(item, snapshot_date=day, captured_at=now)])

    steps: dict[str, Callable[[str], None]] = {
        CONSENSUS_FEED: consensus,
        EARNINGS_FEED: earnings,
        TARGETS_FEED: targets,
    }
    symbols = snapshot_symbols(session)
    reports: dict[str, PassReport] = {}
    for feed, fetch in steps.items():
        if done_today(session, feed, day):
            continue
        reports[feed] = report = _fetch_each(symbols, fetch)
        record_health(session, feed, report.state, now=now, detail=_detail(report))
    return reports


__all__ = ("FEEDS", "done_today", "snapshot_pass", "snapshot_symbols")
