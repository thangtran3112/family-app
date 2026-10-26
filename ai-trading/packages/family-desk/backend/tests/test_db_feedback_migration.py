"""The feedback tables of Alembic 0010 (02s): the database itself refuses what the rules forbid, whoever writes (the
API, the CLI or a stray script), and the indexes the dashboard and the staging sweep rely on exist."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import FeedbackAttachment, FeedbackEvent, FeedbackReport, User

NOW = datetime(2026, 10, 26, 14, 0, tzinfo=UTC)
PNG = b"\x89PNG\r\n\x1a\n"


def make_user(db: Session) -> User:
    user = User(email="filer@example.com", settings={})
    db.add(user)
    db.flush()
    return user


def report(user: User, **over) -> FeedbackReport:
    fields = {
        "user_id": user.id,
        "kind": "bug",
        "severity": "P2",
        "title": "A title",
        "body": "A body",
        "screen": "Today",
        "route": "/",
        "app_version": "dev",
        "context": {},
        "captured_at": NOW,
        "links": [],
        "status": "open",
        "created_at": NOW,
        "updated_at": NOW,
    }
    return FeedbackReport(**{**fields, **over})


@pytest.mark.parametrize(
    "over",
    [
        {"severity": None},  # a bug needs a severity
        {"kind": "request"},  # a request has none
        {"kind": "idea", "severity": None},
        {"severity": "P9"},
        {"status": "fixed"},  # fixed without a fix reference
        {"status": "duplicate"},  # duplicate without an original
        {"status": "done"},
    ],
)
def test_the_database_refuses_a_report_that_breaks_a_rule(db_session: Session, over) -> None:
    user = make_user(db_session)
    db_session.add(report(user, **over))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_the_database_accepts_the_valid_shapes(db_session: Session) -> None:
    user = make_user(db_session)
    original = report(user)
    db_session.add_all(
        [
            original,
            report(user, kind="request", severity=None),
            report(user, status="fixed", fix_ref="1a2b3c4"),
        ]
    )
    db_session.flush()
    db_session.add(report(user, status="duplicate", duplicate_of=original.id))
    db_session.flush()


def test_an_attachment_over_five_megabytes_is_refused_by_the_database(db_session: Session) -> None:
    user = make_user(db_session)
    fields = {"user_id": user.id, "filename": "a.png", "content_type": "image/png", "sha256": "0" * 64}
    db_session.add(FeedbackAttachment(**fields, size_bytes=5 * 1024 * 1024, payload=PNG, created_at=NOW))
    db_session.flush()  # exactly the limit is fine
    db_session.add(FeedbackAttachment(**fields, size_bytes=5 * 1024 * 1024 + 1, payload=PNG, created_at=NOW))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_events_and_attachments_go_with_their_report_but_a_staged_file_has_no_report(db_session: Session) -> None:
    user = make_user(db_session)
    filed = report(user)
    db_session.add(filed)
    db_session.flush()
    db_session.add(FeedbackEvent(report_id=filed.id, at=NOW, actor="user", from_status=None, to_status="open"))
    fields = {"user_id": user.id, "filename": "a.png", "content_type": "image/png", "sha256": "0", "size_bytes": 8}
    db_session.add(FeedbackAttachment(**fields, report_id=filed.id, payload=PNG, created_at=NOW))
    db_session.add(FeedbackAttachment(**fields, report_id=None, payload=PNG, created_at=NOW))  # staged
    db_session.flush()
    db_session.execute(delete(FeedbackReport).where(FeedbackReport.id == filed.id))
    assert db_session.scalar(text("SELECT count(*) FROM feedback_events")) == 0
    assert db_session.scalar(text("SELECT count(*) FROM feedback_attachments")) == 1  # the staged one stays


def test_an_id_is_never_handed_out_twice(db_session: Session) -> None:
    user = make_user(db_session)
    first = report(user)
    db_session.add(first)
    db_session.flush()
    first_id = first.id
    db_session.execute(delete(FeedbackReport).where(FeedbackReport.id == first_id))
    second = report(user)
    db_session.add(second)
    db_session.flush()
    assert second.id > first_id


def test_the_indexes_of_the_spec_exist(db_engine) -> None:
    inspector = inspect(db_engine)
    reports = {i["name"]: i for i in inspector.get_indexes("feedback_reports")}
    assert {"ix_feedback_reports_status_id", "ix_feedback_reports_user_id"} <= set(reports)
    assert reports["ix_feedback_reports_status_id"]["column_names"][0] == "status"
    assert {i["name"] for i in inspector.get_indexes("feedback_events")} == {"ix_feedback_events_report_id_at"}
    attachments = {i["name"]: i for i in inspector.get_indexes("feedback_attachments")}
    assert set(attachments) == {"ix_feedback_attachments_report_id", "ix_feedback_attachments_user_staged"}
    staged = attachments["ix_feedback_attachments_user_staged"]
    assert (
        staged["column_names"] == ["user_id"] and "report_id IS NULL" in staged["dialect_options"]["postgresql_where"]
    )
