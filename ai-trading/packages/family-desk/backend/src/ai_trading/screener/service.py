"""Filter CRUD (02m §b1 `screener/service.py`): seed copies, versions, archive, and the stored results.

Every row is scoped to its owner and a non-owner gets the same `FilterNotFound` as a missing id, so the API
answers 404 either way. Seeds are per-user read-only copies (`origin == "seed"`); editing one is
`FilterReadOnly` (409). Each save writes a new version unless the spec is unchanged.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.contracts.strategy_spec_v1 import FilterStrategySpecV1
from ai_trading.db.models import FilterRun, FilterStrategy, FilterStrategyVersion, SymbolMetrics, UniverseSymbol
from ai_trading.library.catalog import load_catalog, load_template
from ai_trading.screener.runner import newest_run

COPY_SUFFIX = " (copy)"
NAME_MAX = 80


class FilterNotFound(Exception):
    """No such filter for this user (missing, archived, or someone else's)."""


class FilterReadOnly(Exception):
    """A seed cannot be edited or deleted; copy it first."""


class NameTaken(Exception):
    """The user already has a live filter with this name."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(name)


@dataclass(frozen=True)
class FilterView:
    row: FilterStrategy
    version: FilterStrategyVersion

    @property
    def spec(self) -> dict[str, Any]:
        return self.version.spec

    @property
    def read_only(self) -> bool:
        return self.row.origin == "seed"


def dump_spec(spec: FilterStrategySpecV1) -> dict[str, Any]:
    return spec.model_dump(mode="json", by_alias=True, exclude_none=True)


def seed_order() -> dict[str, int]:
    """Catalog position of each filter preset, so the ten seeds list in the catalog's order."""
    entries = [e for e in load_catalog().entries if e.kind == "filter"]
    return {entry.id: index for index, entry in enumerate(entries)}


def ensure_seed_filters(session: Session, user_id: int, *, now: datetime) -> int:
    """Give the user the catalog's default filters she does not have yet; returns how many were added.

    Nothing else seeds a real user (`cli/seed_technical.py` is an operator step), so the screener lists this first.
    A name she already uses for her own filter keeps its place and that default is skipped. A parallel request that
    seeded first wins the unique index: the savepoint rolls back and this one adds nothing."""
    have = set(
        session.execute(
            select(FilterStrategy.seed_key).where(
                FilterStrategy.owner_user_id == user_id, FilterStrategy.origin == "seed"
            )
        ).scalars()
    )
    added = 0
    try:
        with session.begin_nested():
            for entry in load_catalog().entries:
                if entry.kind != "filter" or entry.id in have:
                    continue
                try:
                    _insert(
                        session,
                        user_id,
                        seed_spec(entry.id) or {},
                        seed_key=entry.id,
                        origin="seed",
                        note="seeded",
                        now=now,
                    )
                except NameTaken:
                    continue
                added += 1
    except IntegrityError:
        return 0
    return added


def seed_spec(seed_key: str) -> dict[str, Any] | None:
    """The shipped template a seed or a copy of one started from (the editor's "Reset to default")."""
    entry = next((e for e in load_catalog().entries if e.kind == "filter" and e.id == seed_key), None)
    if entry is None:
        return None
    return dump_spec(FilterStrategySpecV1.model_validate(load_template(entry.file)))


def _view(session: Session, filter_id: int, user_id: int) -> FilterView:
    row = session.get(FilterStrategy, filter_id)
    if row is None or row.owner_user_id != user_id or row.archived_at is not None or row.current_version_id is None:
        raise FilterNotFound(filter_id)
    return FilterView(row, session.get(FilterStrategyVersion, row.current_version_id))


def get_filter(session: Session, user_id: int, filter_id: int) -> FilterView:
    return _view(session, filter_id, user_id)


def list_filters(session: Session, user_id: int) -> list[FilterView]:
    """The seeds in catalog order, then the user's own by name."""
    rows = session.execute(
        select(FilterStrategy, FilterStrategyVersion)
        .join(FilterStrategyVersion, FilterStrategyVersion.id == FilterStrategy.current_version_id)
        .where(FilterStrategy.owner_user_id == user_id, FilterStrategy.archived_at.is_(None))
    ).all()
    order = seed_order()
    views = [FilterView(row, version) for row, version in rows]
    views.sort(
        key=lambda v: (v.row.origin != "seed", order.get(v.row.seed_key or "", len(order)), v.row.name.casefold())
    )
    return views


def _live_names(session: Session, user_id: int, *, excluding: int | None = None) -> set[str]:
    query = select(FilterStrategy.name).where(
        FilterStrategy.owner_user_id == user_id, FilterStrategy.archived_at.is_(None)
    )
    if excluding is not None:
        query = query.where(FilterStrategy.id != excluding)
    return {name.casefold() for name in session.execute(query).scalars()}


def _copy_name(session: Session, user_id: int, source_name: str) -> str:
    taken = _live_names(session, user_id)
    base = source_name[: NAME_MAX - len(COPY_SUFFIX) - 4]
    name = f"{base}{COPY_SUFFIX}"
    number = 2
    while name.casefold() in taken:
        name = f"{base} (copy {number})"
        number += 1
    return name


def _insert(
    session: Session, user_id: int, spec: dict[str, Any], *, seed_key: str | None, origin: str, note: str, now: datetime
) -> FilterView:
    if spec["name"].casefold() in _live_names(session, user_id):
        raise NameTaken(spec["name"])
    row = FilterStrategy(owner_user_id=user_id, name=spec["name"], origin=origin, seed_key=seed_key, created_at=now)
    session.add(row)
    session.flush()
    version = FilterStrategyVersion(
        filter_strategy_id=row.id,
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
    return FilterView(row, version)


def create_from_copy(session: Session, user_id: int, source_id: int, *, now: datetime) -> FilterView:
    source = _view(session, source_id, user_id)
    name = _copy_name(session, user_id, source.row.name)
    return _insert(
        session,
        user_id,
        {**source.spec, "name": name},
        seed_key=source.row.seed_key,
        origin="user",
        note=f"copied from {source.row.name}",
        now=now,
    )


def create_from_spec(session: Session, user_id: int, spec: dict[str, Any], *, now: datetime) -> FilterView:
    return _insert(session, user_id, spec, seed_key=None, origin="user", note="created", now=now)


def update_filter(
    session: Session, user_id: int, filter_id: int, spec: dict[str, Any], change_note: str | None, *, now: datetime
) -> FilterView:
    view = _view(session, filter_id, user_id)
    if view.read_only:
        raise FilterReadOnly(filter_id)
    if spec == view.spec:
        return view  # an unchanged save is not a new version
    if spec["name"].casefold() in _live_names(session, user_id, excluding=filter_id):
        raise NameTaken(spec["name"])
    last = session.execute(
        select(func.max(FilterStrategyVersion.version)).where(FilterStrategyVersion.filter_strategy_id == filter_id)
    ).scalar_one()
    version = FilterStrategyVersion(
        filter_strategy_id=filter_id,
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
    try:
        session.flush()
    except IntegrityError as exc:  # a concurrent rename took the name between the check and the write
        session.rollback()
        raise NameTaken(spec["name"]) from exc
    return FilterView(view.row, version)


def archive_filter(session: Session, user_id: int, filter_id: int, *, now: datetime) -> None:
    view = _view(session, filter_id, user_id)
    if view.read_only:
        raise FilterReadOnly(filter_id)
    view.row.archived_at = now


def last_run(session: Session, view: FilterView) -> FilterRun | None:
    return newest_run(session, view.version.id)


@dataclass(frozen=True)
class UniverseCounts:
    candidates: int
    scanned: int
    dropped_non_plain: int
    no_daily_data: int
    as_of: datetime | None
    quality: str | None


def universe_counts(session: Session) -> UniverseCounts:
    """The screener header, counted from `universe_symbols` (see `data/universe.py` for the reasons stored)."""
    reason = UniverseSymbol.floor_reason["reason"].astext
    counts = session.execute(
        select(
            func.count().filter(UniverseSymbol.active.is_(True)),
            func.count().filter(UniverseSymbol.active.is_(True), UniverseSymbol.passed_floor.is_(True)),
            func.count().filter(reason == "non_plain_ticker"),
            func.count().filter(UniverseSymbol.active.is_(True), reason == "no_daily_data"),
        )
    ).one()
    newest = session.execute(
        select(SymbolMetrics.as_of, SymbolMetrics.quality).order_by(SymbolMetrics.as_of.desc()).limit(1)
    ).first()
    return UniverseCounts(
        *counts, as_of=None if newest is None else newest[0], quality=None if newest is None else newest[1]
    )
