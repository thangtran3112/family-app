from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.database import Base
from app.core.sqlite_compat import compile_tsvector  # noqa: F401

if TYPE_CHECKING:
    from app.models.category import Category
    from app.models.expense_file import ExpenseFile
    from app.models.project import Project
    from app.models.tag import ExpenseTag
    from app.models.tenant import Tenant
    from app.models.user import User


class ExpenseSource(str, enum.Enum):
    MANUAL = "MANUAL"
    EMAIL = "EMAIL"
    MANUAL_AND_EMAIL = "MANUAL_AND_EMAIL"


class ExpenseStatus(str, enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    REVIEW = "REVIEW"
    COMPLETED = "COMPLETED"
    DUPLICATE = "DUPLICATE"
    ERROR = "ERROR"


class TaxDeductionType(str, enum.Enum):
    BUSINESS = "BUSINESS"
    HOME_OFFICE = "HOME_OFFICE"
    VEHICLE = "VEHICLE"
    MIXED = "MIXED"
    NONE = "NONE"


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid,
        ForeignKey("categories.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("projects.id", ondelete="SET NULL"), index=True, nullable=True
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    merchant: Mapped[str | None] = mapped_column(String(100), index=True, nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    converted_amount: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 2), nullable=True
    )
    base_currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), index=True, nullable=False
    )

    source: Mapped[ExpenseSource] = mapped_column(
        Enum(ExpenseSource), default=ExpenseSource.MANUAL, nullable=False
    )
    status: Mapped[ExpenseStatus] = mapped_column(
        Enum(ExpenseStatus), default=ExpenseStatus.PENDING, nullable=False
    )

    # Tax deduction attribution
    is_tax_deductible: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    tax_deduction_type: Mapped[TaxDeductionType] = mapped_column(
        Enum(TaxDeductionType), default=TaxDeductionType.BUSINESS, nullable=False
    )
    tax_deduction_percent: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("100.00"), nullable=False
    )

    # Deduplication & Verification
    content_hash: Mapped[str | None] = mapped_column(
        String(64), index=True, nullable=True
    )

    # OCR & AI Extraction
    ocr_raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    ai_extracted_data: Mapped[dict[str, Any] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )
    line_items: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )

    # Vector & Search
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    search_vector: Mapped[Any | None] = mapped_column(TSVECTOR, nullable=True)

    # Knowledge Graph Link
    graph_node_id: Mapped[str | None] = mapped_column(
        String(100), index=True, nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    # Relationships
    tenant: Mapped[Tenant] = relationship("Tenant", back_populates="expenses")
    user: Mapped[User] = relationship("User", back_populates="expenses")
    category: Mapped[Category | None] = relationship(
        "Category", back_populates="expenses"
    )
    project: Mapped[Project | None] = relationship("Project", back_populates="expenses")
    files: Mapped[list[ExpenseFile]] = relationship(
        "ExpenseFile", back_populates="expense", cascade="all, delete-orphan"
    )
    tags: Mapped[list[ExpenseTag]] = relationship(
        "ExpenseTag", back_populates="expense", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_expenses_tenant_date", "tenant_id", "date"),
        Index("ix_expenses_tenant_category", "tenant_id", "category_id"),
        Index("ix_expenses_tenant_project", "tenant_id", "project_id"),
        Index("ix_expenses_tenant_content_hash", "tenant_id", "content_hash"),
    )
