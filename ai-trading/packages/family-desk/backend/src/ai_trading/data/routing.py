"""The family-scoped provider preference (02t §3.5, ruling 12).

One row per data class in `market_data_routing`: the preferred provider (or none) and the version the
bridge was last told. The bridge's cached copy is the runtime truth; this table is the Desk's record of
it, which is what lets `jobs/bridge_routing.py` re-sync a restarted bridge without a Settings visit, and
what `PUT /api/desk/settings/market-data` writes before it calls `SetRouting`.

The version is family-wide but stored per row (the table is keyed by class): a write bumps every row it
touches to the same value, and the family's version is the maximum, so a class left alone by a later
write still carries an older number that never matters.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai_trading.db.models import MarketDataRouting

#: The bridge's data classes, in the order the Settings card shows them (02t §3.2 `DataClass`).
DATA_CLASSES = ("equity_quotes", "equity_bars", "option_chain")


@dataclass(frozen=True)
class StoredRouting:
    """What the Desk has recorded: `preferences[class]` is a provider name, "" for none. `version` 0
    means the toggle has never been used, so there is nothing to sync onto the bridge."""

    preferences: dict[str, str]
    version: int

    @property
    def unused(self) -> bool:
        return self.version == 0


def read(session: Session) -> StoredRouting:
    """Every stored row, as the preference map and its highest version."""
    rows = session.execute(select(MarketDataRouting)).scalars().all()
    return StoredRouting(
        preferences={row.data_class: (row.preferred or "") for row in rows},
        version=max((row.version for row in rows), default=0),
    )


def record(
    session: Session, *, data_class: str, provider: str, updated_by: str, now: datetime
) -> StoredRouting:
    """Stores one class's preference and returns the whole record with the bumped version. The caller
    commits: a `SetRouting` that fails afterwards rolls the row back with the request's transaction."""

    if data_class not in DATA_CLASSES:
        raise ValueError(f"unknown data class {data_class!r}")
    stored = read(session)
    version = stored.version + 1
    row = session.get(MarketDataRouting, data_class)
    if row is None:
        row = MarketDataRouting(data_class=data_class, preferred=None, version=version)
        session.add(row)
    row.preferred = provider or None
    row.version = version
    row.updated_by = updated_by
    row.updated_at = now
    session.flush()
    return StoredRouting(preferences={**stored.preferences, data_class: provider}, version=version)


def tables_exist(session: Session) -> bool:
    """The routing table answers a trivial query, so a status route can say "not migrated yet" instead
    of failing the whole page on a database one revision behind."""
    try:
        session.execute(select(func.count()).select_from(MarketDataRouting)).scalar_one()
    except Exception:  # noqa: BLE001 -- a missing table (pre-0013) is the only expected case
        return False
    return True


__all__ = ("DATA_CLASSES", "StoredRouting", "read", "record", "tables_exist")