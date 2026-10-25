"""Replay practice (Alembic `0004`, 02o c3) table constraints: one attempt per (owner, symbol, day, attempt),
at most one active session per (owner, symbol, day), mark sequence uniqueness, the status/kind/source/rating
checks, the replay_notable_days and replay_blobs keys, and cascades from user to sessions to marks.
Needs a real Postgres (`scripts/test-db.sh`).

Test emails below are throwaway fixtures (example.test), never a real address.
"""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import delete, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import PracticeMark, ReplayBlob, ReplayNotableDay, ReplaySession, User

NOW = datetime(2026, 10, 24, 20, 0, tzinfo=UTC)
DAY = date(2026, 10, 23)


def _make_user(session: Session, email: str = "owner@example.test") -> int:
    user_id = session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()
    session.commit()
    return user_id


def _make_session(session: Session, user_id: int, **overrides: Any) -> int:
    values: dict[str, Any] = {
        "owner_user_id": user_id,
        "symbol": "AAPL",
        "day": DAY,
        "attempt": 1,
        "schema_version": 1,
        "spec": {"template": "gap-and-go"},
        "armed": [],
        "signals": [],
        "window_start": NOW,
        "window_end": NOW,
        "revealed_through": NOW,
        "tape_feed": "sip",
        "status": "active",
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    session_id = session.execute(insert(ReplaySession).values(**values).returning(ReplaySession.id)).scalar_one()
    session.commit()
    return session_id


def _make_mark(session: Session, session_id: int, seq: int = 1, **overrides: Any) -> None:
    values: dict[str, Any] = {
        "session_id": session_id,
        "seq": seq,
        "kind": "long_entry",
        "at": NOW,
        "price": Decimal("101.250000"),
        "source": "her",
        "created_at": NOW,
    }
    values.update(overrides)
    session.execute(insert(PracticeMark).values(**values))
    session.commit()


# --- replay_sessions: unique (owner, symbol, day, attempt) and one active per (owner, symbol, day) -----


def test_replay_sessions_unique_attempt_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_session(db_session, user_id, status="ended")
    with pytest.raises(IntegrityError):
        _make_session(db_session, user_id, status="ended")
    db_session.rollback()


def test_replay_sessions_same_symbol_day_can_be_replayed_as_a_new_attempt(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_session(db_session, user_id, attempt=1, status="ended")
    _make_session(db_session, user_id, attempt=2, status="ended")  # "Replay this day again"


def test_replay_sessions_allows_only_one_active_session_per_symbol_and_day(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_session(db_session, user_id, attempt=1, status="active")
    with pytest.raises(IntegrityError):
        _make_session(db_session, user_id, attempt=2, status="active")
    db_session.rollback()


def test_replay_sessions_active_index_skips_ended_attempts(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_session(db_session, user_id, attempt=1, status="ended")
    _make_session(db_session, user_id, attempt=2, status="active")  # the one active attempt
    _make_session(db_session, user_id, attempt=3, status="ended")  # ended rows are not constrained


def test_replay_sessions_one_active_is_scoped_to_owner_symbol_and_day(db_session: Session) -> None:
    first = _make_user(db_session, "first@example.test")
    second = _make_user(db_session, "second@example.test")
    _make_session(db_session, first, symbol="AAPL", status="active")
    _make_session(db_session, first, symbol="MSFT", status="active")  # another symbol, same day
    _make_session(db_session, first, symbol="AAPL", day=date(2026, 10, 22), status="active")  # another day
    _make_session(db_session, second, symbol="AAPL", status="active")  # another owner


@pytest.mark.parametrize("status", ["paused", "", "ACTIVE"])
def test_replay_sessions_status_check_rejects_an_unknown_value(db_session: Session, status: str) -> None:
    user_id = _make_user(db_session)
    with pytest.raises(IntegrityError):
        _make_session(db_session, user_id, status=status)
    db_session.rollback()


@pytest.mark.parametrize("rating", [0, 6])
def test_replay_sessions_rating_check_rejects_a_value_outside_one_to_five(db_session: Session, rating: int) -> None:
    user_id = _make_user(db_session)
    with pytest.raises(IntegrityError):
        _make_session(db_session, user_id, rating=rating)
    db_session.rollback()


def test_replay_sessions_rating_accepts_one_to_five_and_null(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _make_session(db_session, user_id, attempt=1, rating=1, status="ended")
    _make_session(db_session, user_id, attempt=2, rating=5, status="ended")
    _make_session(db_session, user_id, attempt=3, rating=None, status="ended")


# --- practice_marks: unique (session_id, seq); kind and source checks; nullable price for a note ------


def test_practice_marks_unique_session_and_seq_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    _make_mark(db_session, session_id, seq=1)
    with pytest.raises(IntegrityError):
        _make_mark(db_session, session_id, seq=1)
    db_session.rollback()


def test_practice_marks_seq_is_unique_per_session_not_globally(db_session: Session) -> None:
    user_id = _make_user(db_session)
    first_id = _make_session(db_session, user_id, attempt=1, status="ended")
    second_id = _make_session(db_session, user_id, attempt=2, status="ended")
    _make_mark(db_session, first_id, seq=1)
    _make_mark(db_session, second_id, seq=1)  # no IntegrityError: the pair (session_id, seq) differs


@pytest.mark.parametrize("kind", ["buy", "long_exit_partial", "NOTE"])
def test_practice_marks_kind_check_rejects_an_unknown_kind(db_session: Session, kind: str) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    with pytest.raises(IntegrityError):
        _make_mark(db_session, session_id, kind=kind)
    db_session.rollback()


def test_practice_marks_source_check_rejects_an_unknown_source(db_session: Session) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    with pytest.raises(IntegrityError):
        _make_mark(db_session, session_id, source="bot")
    db_session.rollback()


def test_practice_marks_note_has_no_price_and_a_price_round_trips_at_six_places(db_session: Session) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    _make_mark(db_session, session_id, seq=1, kind="note", price=None, note="late reaction", source="her")
    _make_mark(db_session, session_id, seq=2, kind="stop", price=Decimal("99.123456"), stop_price=Decimal("98.5"))
    rows = db_session.execute(
        select(PracticeMark.seq, PracticeMark.price, PracticeMark.stop_price)
        .where(PracticeMark.session_id == session_id)
        .order_by(PracticeMark.seq)
    ).all()
    assert [tuple(row) for row in rows] == [
        (1, None, None),
        (2, Decimal("99.123456"), Decimal("98.500000")),
    ]


# --- replay_notable_days: primary key (symbol, day) ----------------------------------------------------


def test_replay_notable_days_primary_key_rejects_a_duplicate_symbol_and_day(db_session: Session) -> None:
    row = {
        "symbol": "AAPL",
        "day": DAY,
        "rv": 3.2,
        "rv_pct_rank": 0.97,
        "gap_pct": 4.1,
        "rvol": None,
        "tags": ["gap", "volume"],
        "computed_at": NOW,
    }
    db_session.execute(insert(ReplayNotableDay).values(**row))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(ReplayNotableDay).values(**row))
        db_session.commit()
    db_session.rollback()


# --- replay_blobs: primary key (kind, symbol, day, part, feed); part defaults to '' -----------------------


def test_replay_blobs_part_defaults_to_an_empty_string(db_session: Session) -> None:
    db_session.execute(
        text(
            "INSERT INTO replay_blobs (kind, symbol, day, feed, payload, row_count, raw_bytes, created_at) "
            "VALUES ('bars1d', 'AAPL', :day, 'sip', :payload, 1, 10, :now)"
        ),
        {"day": DAY, "payload": b"\x1f\x8b", "now": NOW},
    )
    db_session.commit()
    part = db_session.execute(text("SELECT part FROM replay_blobs WHERE kind = 'bars1d'")).scalar_one()
    assert part == ""


def test_replay_blobs_primary_key_rejects_a_duplicate_and_allows_another_part_or_feed(db_session: Session) -> None:
    def blob(part: str, feed: str) -> dict[str, Any]:
        return {
            "kind": "tape",
            "symbol": "AAPL",
            "day": DAY,
            "part": part,
            "feed": feed,
            "payload": b"\x1f\x8b",
            "row_count": 5,
            "raw_bytes": 50,
            "created_at": NOW,
        }

    db_session.execute(insert(ReplayBlob).values(**blob("0930", "sip")))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(ReplayBlob).values(**blob("0930", "sip")))
        db_session.commit()
    db_session.rollback()
    db_session.execute(insert(ReplayBlob).values(**blob("1000", "sip")))  # another 30-minute chunk
    db_session.execute(insert(ReplayBlob).values(**blob("0930", "iex")))  # the same chunk on another feed
    db_session.commit()


# --- cascades: user -> sessions -> marks ----------------------------------------------------------------


def test_deleting_a_user_cascades_to_their_sessions_and_marks(db_session: Session) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    _make_mark(db_session, session_id, seq=1)
    _make_mark(db_session, session_id, seq=2, kind="long_exit", price=Decimal("103.000000"))
    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()
    assert db_session.execute(select(ReplaySession).where(ReplaySession.id == session_id)).scalars().all() == []
    assert db_session.execute(select(PracticeMark).where(PracticeMark.session_id == session_id)).scalars().all() == []


def test_deleting_a_session_cascades_to_its_marks(db_session: Session) -> None:
    user_id = _make_user(db_session)
    session_id = _make_session(db_session, user_id)
    _make_mark(db_session, session_id, seq=1)
    db_session.execute(delete(ReplaySession).where(ReplaySession.id == session_id))
    db_session.commit()
    assert db_session.execute(select(PracticeMark).where(PracticeMark.session_id == session_id)).scalars().all() == []
