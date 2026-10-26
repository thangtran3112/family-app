"""feedback log: feedback_reports, feedback_events, feedback_attachments

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-26

Additive (02s, P1): three new tables and nothing else; no existing table or row changes. `feedback_reports` holds the
bugs and feature requests the family files from the Desk (the serial `id` is the `F-nnn` the family sees, and a
Postgres sequence never hands one out twice), `feedback_events` the status timeline of each, and `feedback_attachments`
the screenshots as `bytea`, like `replay_blobs.payload`: the Desk has no data volume of its own. A staged screenshot
(uploaded before its report exists) has a null `report_id`. `downgrade()` drops the three tables, children first.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feedback_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("severity", sa.String(), nullable=True),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("expected", sa.Text(), nullable=True),
        sa.Column("screen", sa.Text(), nullable=False),
        sa.Column("route", sa.Text(), nullable=False),
        sa.Column("app_version", sa.Text(), nullable=False),
        sa.Column("context", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("links", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'open'")),
        sa.Column("fix_ref", sa.Text(), nullable=True),
        sa.Column("duplicate_of", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('bug', 'request')", name="ck_feedback_reports_kind"),
        sa.CheckConstraint(
            "severity IS NULL OR severity IN ('P0', 'P1', 'P2', 'P3')", name="ck_feedback_reports_severity"
        ),
        sa.CheckConstraint("(kind = 'bug') = (severity IS NOT NULL)", name="ck_feedback_reports_kind_severity"),
        sa.CheckConstraint(
            "status IN ('open', 'in_progress', 'fixed', 'wont_fix', 'duplicate')", name="ck_feedback_reports_status"
        ),
        sa.CheckConstraint("status <> 'fixed' OR fix_ref IS NOT NULL", name="ck_feedback_reports_fixed_ref"),
        sa.CheckConstraint(
            "status <> 'duplicate' OR duplicate_of IS NOT NULL", name="ck_feedback_reports_duplicate_of"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_feedback_reports_user_id_users"),
        sa.ForeignKeyConstraint(
            ["duplicate_of"], ["feedback_reports.id"], name="fk_feedback_reports_duplicate_of_feedback_reports"
        ),
    )
    op.create_index("ix_feedback_reports_status_id", "feedback_reports", ["status", sa.text("id DESC")])
    op.create_index("ix_feedback_reports_user_id", "feedback_reports", ["user_id"])

    op.create_table(
        "feedback_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("from_status", sa.String(), nullable=True),
        sa.Column("to_status", sa.String(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["feedback_reports.id"],
            name="fk_feedback_events_report_id_feedback_reports",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_feedback_events_report_id_at", "feedback_events", ["report_id", "at"])

    op.create_table(
        "feedback_attachments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("report_id", sa.Integer(), nullable=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("size_bytes <= 5242880", name="ck_feedback_attachments_size_bytes"),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["feedback_reports.id"],
            name="fk_feedback_attachments_report_id_feedback_reports",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_feedback_attachments_user_id_users"),
    )
    op.create_index("ix_feedback_attachments_report_id", "feedback_attachments", ["report_id"])
    # The staging sweep and the six-staged-files cap look only at files with no report yet.
    op.create_index(
        "ix_feedback_attachments_user_staged",
        "feedback_attachments",
        ["user_id"],
        postgresql_where=sa.text("report_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("feedback_attachments")
    op.drop_table("feedback_events")
    op.drop_table("feedback_reports")
