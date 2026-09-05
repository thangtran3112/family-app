"""initial schema with multi-tenancy, taxonomy, expenses, vector, and audit

Revision ID: 001
Revises:
Create Date: 2026-09-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 0. Enable pgvector extension
    op.execute('CREATE EXTENSION IF NOT EXISTS "vector";')

    # 1. Tenants table
    op.create_table(
        "tenants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("slug", sa.String(100), nullable=False, unique=True),
        sa.Column(
            "llm_monthly_budget",
            sa.Numeric(10, 2),
            nullable=True,
            server_default="20.00",
        ),
        sa.Column(
            "llm_monthly_used", sa.Numeric(10, 2), nullable=False, server_default="0.00"
        ),
        sa.Column("llm_budget_reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_tenants_slug", "tenants", ["slug"])

    # 2. Users table
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role", sa.String(50), nullable=False, server_default="owner"),
        sa.Column("avatar_url", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"])

    # 3. Categories table
    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("color", sa.String(7), nullable=True, server_default="#6B7280"),
        sa.Column("icon", sa.String(50), nullable=True, server_default="tag"),
        sa.Column("system_prompt", sa.String(1000), nullable=True),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_categories_tenant_name"),
    )

    # 4. Projects table
    op.create_table(
        "projects",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("color", sa.String(7), nullable=True, server_default="#3B82F6"),
        sa.Column("icon", sa.String(50), nullable=True, server_default="briefcase"),
        sa.Column(
            "business_type",
            sa.String(50),
            nullable=True,
            server_default="Sole Proprietorship",
        ),
        sa.Column("tax_year", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("system_prompt", sa.String(1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_projects_tenant_name"),
    )

    # 5. Tags table
    op.create_table(
        "tags",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("color", sa.String(7), nullable=True, server_default="#10B981"),
        sa.Column(
            "is_auto_generated", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_tags_tenant_name"),
    )

    # 6. Expenses table
    op.create_table(
        "expenses",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "category_id",
            sa.Uuid(),
            sa.ForeignKey("categories.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("merchant", sa.String(100), nullable=True, index=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("converted_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("base_currency", sa.String(3), nullable=False, server_default="USD"),
        sa.Column("date", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("source", sa.String(30), nullable=False, server_default="MANUAL"),
        sa.Column("status", sa.String(30), nullable=False, server_default="PENDING"),
        sa.Column(
            "is_tax_deductible", sa.Boolean(), nullable=False, server_default="true"
        ),
        sa.Column(
            "tax_deduction_type",
            sa.String(30),
            nullable=False,
            server_default="BUSINESS",
        ),
        sa.Column(
            "tax_deduction_percent",
            sa.Numeric(5, 2),
            nullable=False,
            server_default="100.00",
        ),
        sa.Column("content_hash", sa.String(64), nullable=True, index=True),
        sa.Column("ocr_raw_text", sa.Text(), nullable=True),
        sa.Column("ocr_confidence", sa.Float(), nullable=True),
        sa.Column(
            "ai_extracted_data", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column("line_items", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("embedding", Vector(1536), nullable=True),
        sa.Column("search_vector", postgresql.TSVECTOR(), nullable=True),
        sa.Column("graph_node_id", sa.String(100), nullable=True, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_expenses_tenant_date", "expenses", ["tenant_id", "date"])
    op.create_index(
        "ix_expenses_tenant_category", "expenses", ["tenant_id", "category_id"]
    )
    op.create_index(
        "ix_expenses_tenant_project", "expenses", ["tenant_id", "project_id"]
    )
    op.create_index(
        "ix_expenses_tenant_content_hash", "expenses", ["tenant_id", "content_hash"]
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_expenses_search_vector ON expenses USING GIN (search_vector);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_expenses_embedding ON expenses USING hnsw (embedding vector_cosine_ops);"
    )

    # 7. Expense Files table
    op.create_table(
        "expense_files",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "expense_id",
            sa.Uuid(),
            sa.ForeignKey("expenses.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("local_path", sa.String(500), nullable=True),
        sa.Column("cloud_storage_url", sa.String(500), nullable=True),
        sa.Column("cloud_storage_key", sa.String(500), nullable=True),
        sa.Column("thumbnail_url", sa.String(500), nullable=True),
        sa.Column("ocr_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 8. Expense Tags table
    op.create_table(
        "expense_tags",
        sa.Column(
            "expense_id",
            sa.Uuid(),
            sa.ForeignKey("expenses.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tag_id",
            sa.Uuid(),
            sa.ForeignKey("tags.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("source", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 9. Duplicate Matches table
    op.create_table(
        "duplicate_matches",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "existing_expense_id",
            sa.Uuid(),
            sa.ForeignKey("expenses.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "candidate_expense_id",
            sa.Uuid(),
            sa.ForeignKey("expenses.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("match_type", sa.String(50), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="PENDING"),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "resolved_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 10. LLM Usage Logs table
    op.create_table(
        "llm_usage_logs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Uuid(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "expense_id",
            sa.Uuid(),
            sa.ForeignKey("expenses.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("operation", sa.String(50), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False, server_default="google"),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "completion_tokens", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "cost_usd", sa.Numeric(8, 6), nullable=False, server_default="0.000000"
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("llm_usage_logs")
    op.drop_table("duplicate_matches")
    op.drop_table("expense_tags")
    op.drop_table("expense_files")
    op.drop_table("expenses")
    op.drop_table("tags")
    op.drop_table("projects")
    op.drop_table("categories")
    op.drop_table("users")
    op.drop_table("tenants")
    op.execute('DROP EXTENSION IF EXISTS "vector";')
