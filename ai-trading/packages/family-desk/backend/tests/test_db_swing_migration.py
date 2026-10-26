"""0008 (swing practice, 02p): the `practice_holds` and `practice_weeks` tables and their constraints, `hold_id` on the
ledger (with a nullable session and mark), and the one-active-plan-per-thread index. The downgrade test runs on its own
database, holding swing data, and must leave a database that satisfies the 0007 expectations.
Needs a real Postgres (`scripts/test-db.sh`). Test emails are throwaway fixtures (example.test)."""

import os
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, delete, insert, inspect, select, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import (
    PracticeHold,
    PracticeLedger,
    PracticeMark,
    PracticePlan,
    PracticeThread,
    PracticeWeek,
    ReplaySession,
    User,
)

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"

NOW = datetime(2026, 10, 24, 16, 0, tzinfo=UTC)
MONDAY = date(2026, 10, 19)
HOLD_COLUMNS = {
    "id",
    "thread_id",
    "owner_user_id",
    "symbol",
    "side",
    "shares",
    "entry_day",
    "entry_at",
    "entry_price",
    "entry_session_id",
    "entry_mark_id",
    "stop_at_entry",
    "stop_price",
    "stop_hit_at",
    "status",
    "exit_day",
    "exit_at",
    "exit_price",
    "exit_session_id",
    "exit_mark_id",
    "exit_source",
    "last_close",
    "last_close_day",
    "splits",
    "created_at",
    "updated_at",
}
WEEK_COLUMNS = {
    "thread_id",
    "owner_user_id",
    "week_no",
    "first_day",
    "last_day",
    "status",
    "review",
    "notes",
    "rating",
    "created_at",
    "closed_at",
}


# -- row helpers (ORM inserts, so the models are exercised too) -------------------------------------------------


def _user(db: Session, email: str = "owner@example.test") -> int:
    user_id = db.execute(insert(User).values(email=email).returning(User.id)).scalar_one()
    db.commit()
    return user_id


def _thread(db: Session, user_id: int, mode: str = "swing", status: str = "active") -> int:
    """`closed` threads do not count against the one-active-thread-per-mode index, so an owner can have several."""
    values: dict[str, Any] = {
        "owner_user_id": user_id,
        "mode": mode,
        "starting_balance": Decimal("50000"),
        "stop_note_on_entry": "yes",
        "trade_only_on_signal": "no",
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
        "closed_at": NOW if status == "closed" else None,
    }
    thread_id = db.execute(insert(PracticeThread).values(**values).returning(PracticeThread.id)).scalar_one()
    db.commit()
    return thread_id


def _plan(db: Session, user_id: int, thread_id: int, status: str = "active") -> int:
    values: dict[str, Any] = {
        "owner_user_id": user_id,
        "thread_id": thread_id,
        "schema_version": 1,
        "spec": {},
        "first_day": MONDAY,
        "universe": {},
        "prep": {},
        "status": status,
        "created_at": NOW,
        "updated_at": NOW,
    }
    plan_id = db.execute(insert(PracticePlan).values(**values).returning(PracticePlan.id)).scalar_one()
    db.commit()
    return plan_id


def _session(db: Session, user_id: int, thread_id: int | None = None, symbol: str = "AAPL") -> int:
    values: dict[str, Any] = {
        "owner_user_id": user_id,
        "thread_id": thread_id,
        "symbol": symbol,
        "day": MONDAY,
        "attempt": 1,
        "schema_version": 1,
        "spec": {},
        "armed": [],
        "signals": [],
        "window_start": NOW,
        "window_end": NOW,
        "revealed_through": NOW,
        "tape_feed": "off",
        "status": "active",
        "created_at": NOW,
        "updated_at": NOW,
    }
    session_id = db.execute(insert(ReplaySession).values(**values).returning(ReplaySession.id)).scalar_one()
    db.commit()
    return session_id


def _mark(db: Session, session_id: int, seq: int = 1, kind: str = "long_exit") -> int:
    values: dict[str, Any] = {
        "session_id": session_id,
        "seq": seq,
        "kind": kind,
        "at": NOW,
        "price": Decimal("101.5"),
        "source": "her",
        "created_at": NOW,
    }
    mark_id = db.execute(insert(PracticeMark).values(**values).returning(PracticeMark.id)).scalar_one()
    db.commit()
    return mark_id


def _hold(db: Session, user_id: int, thread_id: int, **overrides: Any) -> int:
    values: dict[str, Any] = {
        "thread_id": thread_id,
        "owner_user_id": user_id,
        "symbol": "AAPL",
        "side": "long",
        "shares": 10,
        "entry_day": MONDAY,
        "entry_at": NOW,
        "entry_price": Decimal("100.25"),
        "status": "open",
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    hold_id = db.execute(insert(PracticeHold).values(**values).returning(PracticeHold.id)).scalar_one()
    db.commit()
    return hold_id


CLOSED = {"status": "closed", "exit_day": date(2026, 10, 21), "exit_price": Decimal("102"), "exit_source": "auto"}


def _ledger(db: Session, thread_id: int, **overrides: Any) -> int:
    values: dict[str, Any] = {
        "thread_id": thread_id,
        "day": date(2026, 10, 21),
        "symbol": "AAPL",
        "side": "long",
        "shares": 10,
        "entry_price": Decimal("100.25"),
        "exit_price": Decimal("102"),
        "pnl_usd": Decimal("17.50"),
        "realized_at": NOW,
        "created_at": NOW,
    }
    values.update(overrides)
    row_id = db.execute(insert(PracticeLedger).values(**values).returning(PracticeLedger.id)).scalar_one()
    db.commit()
    return row_id


def _week(db: Session, user_id: int, thread_id: int, week_no: int = 1, **overrides: Any) -> None:
    values: dict[str, Any] = {
        "thread_id": thread_id,
        "owner_user_id": user_id,
        "week_no": week_no,
        "first_day": MONDAY,
        "last_day": date(2026, 10, 23),
        "status": "open",
        "created_at": NOW,
    }
    values.update(overrides)
    db.execute(insert(PracticeWeek).values(**values))
    db.commit()


def _count(db: Session, table: str) -> int:
    return db.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one()  # noqa: S608 -- fixed names from this file


# -- schema ---------------------------------------------------------------------------------------------------


def test_upgrade_creates_the_swing_tables_columns_and_indexes(db_engine: Engine) -> None:
    inspector = inspect(db_engine)
    assert {"practice_holds", "practice_weeks"} <= set(inspector.get_table_names())
    assert {c["name"] for c in inspector.get_columns("practice_holds")} == HOLD_COLUMNS
    assert {c["name"] for c in inspector.get_columns("practice_weeks")} == WEEK_COLUMNS
    assert inspector.get_pk_constraint("practice_weeks")["constrained_columns"] == ["thread_id", "week_no"]

    ledger = {c["name"]: c for c in inspector.get_columns("practice_ledger")}
    assert "hold_id" in ledger and ledger["hold_id"]["nullable"]
    assert ledger["session_id"]["nullable"] and ledger["mark_id"]["nullable"]  # an auto exit has neither

    holds = {i["name"]: i for i in inspector.get_indexes("practice_holds")}
    assert holds["uq_practice_holds_thread_id_symbol_open"]["unique"]
    assert holds["ix_practice_holds_thread_id_status"]["column_names"] == ["thread_id", "status"]
    ledger_indexes = {i["name"]: i for i in inspector.get_indexes("practice_ledger")}
    assert ledger_indexes["uq_practice_ledger_hold_id"]["unique"]
    assert ledger_indexes["ix_practice_ledger_hold_id"]["column_names"] == ["hold_id"]

    plans = {i["name"]: i for i in inspector.get_indexes("practice_plans")}
    assert plans["uq_practice_plans_thread_id_active"]["unique"]
    assert "uq_practice_plans_owner_user_id_active" not in plans  # one active plan per THREAD now


# -- practice_holds -------------------------------------------------------------------------------------------


def test_holds_allow_one_open_hold_per_symbol_in_a_thread(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    other_thread = _thread(db_session, user_id, status="closed")
    _hold(db_session, user_id, thread)
    with pytest.raises(IntegrityError):
        _hold(db_session, user_id, thread)  # a second OPEN AAPL hold in the same thread
    db_session.rollback()
    _hold(db_session, user_id, thread, symbol="MSFT")  # another symbol
    _hold(db_session, user_id, other_thread)  # the same symbol in another thread
    _hold(db_session, user_id, thread, **CLOSED)  # closed holds are not constrained, and may repeat
    _hold(db_session, user_id, thread, **CLOSED)


def test_a_symbol_can_be_held_again_once_its_hold_closes(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    first = _hold(db_session, user_id, thread)
    db_session.execute(
        text(
            "UPDATE practice_holds SET status = 'closed', exit_day = :d, exit_price = 102, exit_source = 'her' "
            "WHERE id = :h"
        ),
        {"d": date(2026, 10, 21), "h": first},
    )
    db_session.commit()
    _hold(db_session, user_id, thread)  # a fresh open hold


@pytest.mark.parametrize(
    "overrides",
    [
        {"side": "flat"},
        {"status": "paused"},
        {**CLOSED, "exit_source": "stop"},
        {"shares": 0},
        {"status": "closed"},  # closed with no exit fields
        {"status": "closed", "exit_day": date(2026, 10, 21), "exit_price": Decimal("102")},  # no exit_source
        {"exit_day": date(2026, 10, 21), "exit_price": Decimal("102"), "exit_source": "her"},  # open with exit fields
    ],
)
def test_holds_checks_reject_an_inconsistent_row(db_session: Session, overrides: dict[str, Any]) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    with pytest.raises(IntegrityError):
        _hold(db_session, user_id, thread, **overrides)
    db_session.rollback()


def test_hold_defaults_splits_to_an_empty_list_and_round_trips_six_places(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    hold = _hold(db_session, user_id, thread, entry_price=Decimal("12.345678"), stop_price=Decimal("11.5"))
    row = db_session.execute(select(PracticeHold).where(PracticeHold.id == hold)).scalar_one()
    assert row.splits == [] and row.entry_price == Decimal("12.345678") and row.stop_hit_at is None
    raw = db_session.execute(
        text(
            "INSERT INTO practice_holds (thread_id, owner_user_id, symbol, side, shares, entry_day, entry_at, "
            "entry_price, status, created_at, updated_at) VALUES (:t, :u, 'RAW', 'short', 1, :d, now(), 1, 'open', "
            "now(), now()) RETURNING splits"
        ),
        {"t": thread, "u": user_id, "d": MONDAY},
    ).scalar_one()
    assert raw == []  # the server default, without the ORM's


def test_deleting_the_entry_session_keeps_the_hold_and_deleting_the_thread_removes_it(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    session_id = _session(db_session, user_id, thread)
    mark_id = _mark(db_session, session_id, kind="long_entry")
    hold = _hold(db_session, user_id, thread, entry_session_id=session_id, entry_mark_id=mark_id)
    db_session.execute(delete(ReplaySession).where(ReplaySession.id == session_id))  # takes its marks with it
    db_session.commit()
    row = db_session.execute(select(PracticeHold).where(PracticeHold.id == hold)).scalar_one()
    assert (row.entry_session_id, row.entry_mark_id) == (None, None)
    db_session.execute(delete(PracticeThread).where(PracticeThread.id == thread))
    db_session.commit()
    assert _count(db_session, "practice_holds") == 0


# -- practice_plans: one active plan per thread ---------------------------------------------------------------


def test_plans_allow_one_active_plan_per_thread_not_per_owner(db_session: Session) -> None:
    user_id = _user(db_session)
    day_thread = _thread(db_session, user_id, "day")
    swing_thread = _thread(db_session, user_id, "swing")
    _plan(db_session, user_id, day_thread)
    _plan(db_session, user_id, swing_thread)  # a day thread and a swing thread run together
    with pytest.raises(IntegrityError):
        _plan(db_session, user_id, swing_thread)  # a second active plan on the same thread
    db_session.rollback()
    _plan(db_session, user_id, swing_thread, status="archived")  # archived plans are not constrained
    assert _count(db_session, "practice_plans") == 3


# -- practice_ledger: a swing row names its hold; a day row keeps both ids --------------------------------------


def test_ledger_accepts_a_hold_row_without_session_or_mark(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    hold = _hold(db_session, user_id, thread, **CLOSED)
    _ledger(db_session, thread, hold_id=hold)
    assert _count(db_session, "practice_ledger") == 1


def test_ledger_rejects_a_row_with_neither_hold_nor_session_and_mark(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    session_id = _session(db_session, user_id, thread)
    mark_id = _mark(db_session, session_id)
    for ids in ({}, {"session_id": session_id}, {"mark_id": mark_id}):
        with pytest.raises(IntegrityError):
            _ledger(db_session, thread, **ids)
        db_session.rollback()
    _ledger(db_session, thread, session_id=session_id, mark_id=mark_id)  # a day-trade row keeps both
    assert _count(db_session, "practice_ledger") == 1


def test_ledger_hold_id_is_unique_but_day_rows_may_leave_it_null(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    hold = _hold(db_session, user_id, thread, **CLOSED)
    _ledger(db_session, thread, hold_id=hold)
    with pytest.raises(IntegrityError):
        _ledger(db_session, thread, hold_id=hold)  # booked twice
    db_session.rollback()
    session_id = _session(db_session, user_id, thread)
    for seq in (1, 2):  # two day rows: hold_id stays NULL on both
        _ledger(db_session, thread, session_id=session_id, mark_id=_mark(db_session, session_id, seq))
    assert _count(db_session, "practice_ledger") == 3


def test_deleting_a_hold_removes_its_ledger_row(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    hold = _hold(db_session, user_id, thread, **CLOSED)
    _ledger(db_session, thread, hold_id=hold)
    db_session.execute(delete(PracticeHold).where(PracticeHold.id == hold))
    db_session.commit()
    assert _count(db_session, "practice_ledger") == 0


# -- practice_weeks -------------------------------------------------------------------------------------------


def test_weeks_primary_key_is_thread_and_week_number(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    other_thread = _thread(db_session, user_id, status="closed")
    _week(db_session, user_id, thread, 1)
    _week(db_session, user_id, thread, 2)
    _week(db_session, user_id, other_thread, 1)  # the same week number in another thread
    with pytest.raises(IntegrityError):
        _week(db_session, user_id, thread, 1)
    db_session.rollback()


@pytest.mark.parametrize("rating", [0, 6])
def test_weeks_rating_check_rejects_a_value_outside_one_to_five(db_session: Session, rating: int) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    with pytest.raises(IntegrityError):
        _week(db_session, user_id, thread, rating=rating)
    db_session.rollback()


def test_weeks_accept_ratings_one_to_five_and_null(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    for week_no, rating in enumerate((1, 5, None), start=1):
        _week(db_session, user_id, thread, week_no, rating=rating)


def test_weeks_closed_at_matches_status(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    for week_no, overrides in enumerate(({"status": "closed"}, {"status": "open", "closed_at": NOW}), start=1):
        with pytest.raises(IntegrityError):
            _week(db_session, user_id, thread, week_no, **overrides)
        db_session.rollback()
    _week(db_session, user_id, thread, 3, status="closed", closed_at=NOW, review={"holds": []}, rating=4)
    assert _count(db_session, "practice_weeks") == 1


def test_deleting_a_user_cascades_to_threads_holds_weeks_and_ledger(db_session: Session) -> None:
    user_id = _user(db_session)
    thread = _thread(db_session, user_id)
    hold = _hold(db_session, user_id, thread, **CLOSED)
    _ledger(db_session, thread, hold_id=hold)
    _week(db_session, user_id, thread)
    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()
    for table in ("practice_holds", "practice_weeks", "practice_ledger", "practice_threads"):
        assert _count(db_session, table) == 0, table


# -- downgrade with swing data ---------------------------------------------------------------------------------


@pytest.fixture
def at_0008() -> Iterator[tuple[Engine, Config]]:
    server_url = os.environ.get("DESK_TEST_DATABASE_URL")
    if not server_url:
        if os.environ.get("DESK_REQUIRE_DB") == "1":
            pytest.fail("DESK_TEST_DATABASE_URL is unset and DESK_REQUIRE_DB=1")
        pytest.skip("DESK_TEST_DATABASE_URL is not set")
    name = f"desk_test_{uuid.uuid4().hex[:12]}"
    admin = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(server_url).set(database=name).render_as_string(hide_password=False)
    config = Config(str(_ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "0008")
    engine = create_engine(url)
    try:
        yield engine, config
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin.dispose()


def _seed_swing_data(db: Session) -> dict[str, int]:
    """A day thread with an active plan and a booked day trade, next to a swing thread with an active plan, an
    auto-exited hold (a ledger row with no session or mark), an open hold, and a week."""
    user_id = _user(db)
    day_thread = _thread(db, user_id, "day")
    swing_thread = _thread(db, user_id, "swing")
    day_plan = _plan(db, user_id, day_thread)
    swing_plan = _plan(db, user_id, swing_thread)
    session_id = _session(db, user_id, day_thread)
    day_row = _ledger(db, day_thread, session_id=session_id, mark_id=_mark(db, session_id))
    closed_hold = _hold(db, user_id, swing_thread, **CLOSED)
    swing_row = _ledger(db, swing_thread, hold_id=closed_hold)
    _hold(db, user_id, swing_thread, symbol="MSFT")
    _week(db, user_id, swing_thread)
    return {
        "user": user_id,
        "day_thread": day_thread,
        "swing_thread": swing_thread,
        "day_plan": day_plan,
        "swing_plan": swing_plan,
        "day_row": day_row,
        "swing_row": swing_row,
    }


def test_downgrade_with_swing_data_leaves_a_0007_database_and_upgrade_works_again(at_0008) -> None:
    engine, config = at_0008
    with Session(engine) as db:
        ids = _seed_swing_data(db)

    command.downgrade(config, "0007")

    inspector = inspect(engine)
    assert {"practice_holds", "practice_weeks"}.isdisjoint(inspector.get_table_names())
    ledger = {c["name"]: c for c in inspector.get_columns("practice_ledger")}
    assert "hold_id" not in ledger and not ledger["session_id"]["nullable"] and not ledger["mark_id"]["nullable"]
    plans = {i["name"]: i for i in inspector.get_indexes("practice_plans")}
    assert plans["uq_practice_plans_owner_user_id_active"]["unique"]
    assert "uq_practice_plans_thread_id_active" not in plans
    with Session(engine) as db:
        status = dict(db.execute(select(PracticePlan.id, PracticePlan.status)).all())
        assert status == {ids["day_plan"]: "active", ids["swing_plan"]: "archived"}  # the swing plan was archived
        assert [r for (r,) in db.execute(select(PracticeLedger.id))] == [ids["day_row"]]  # the swing row went
        assert db.execute(select(PracticeThread.id).order_by(PracticeThread.id)).scalars().all() == [
            ids["day_thread"],
            ids["swing_thread"],
        ]  # the 0007 schema accepts a swing thread
        with pytest.raises(IntegrityError):  # the per-owner index is back: one active plan per owner
            _plan(db, ids["user"], ids["swing_thread"])
        db.rollback()

    command.upgrade(config, "head")

    inspector = inspect(engine)
    assert {"practice_holds", "practice_weeks"} <= set(inspector.get_table_names())
    assert "hold_id" in {c["name"] for c in inspector.get_columns("practice_ledger")}
    with Session(engine) as db:
        assert [r for (r,) in db.execute(select(PracticeLedger.id))] == [ids["day_row"]]  # swing data is not restored
        _plan(db, ids["user"], ids["swing_thread"], status="archived")  # and the new tables accept rows again
        _hold(db, ids["user"], ids["swing_thread"])
