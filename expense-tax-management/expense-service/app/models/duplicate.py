from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, Float, ForeignKey, String, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.expense import Expense
    from app.models.tenant import Tenant
    from app.models.user import User


class DuplicateMatch(Base):
    __tablename__ = "duplicate_matches"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=False
    )
    existing_expense_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("expenses.id", ondelete="CASCADE"), index=True, nullable=False
    )
    candidate_expense_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("expenses.id", ondelete="CASCADE"), index=True, nullable=False
    )

    match_type: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # content_hash, phash, semantic, order_number
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default="PENDING", nullable=False
    )  # PENDING, MERGED, DISMISSED, SEPARATE
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    details: Mapped[dict[str, Any] | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )

    # Relationships
    tenant: Mapped[Tenant] = relationship("Tenant")
    existing_expense: Mapped[Expense] = relationship(
        "Expense", foreign_keys=[existing_expense_id]
    )
    candidate_expense: Mapped[Expense] = relationship(
        "Expense", foreign_keys=[candidate_expense_id]
    )
    resolver: Mapped[User | None] = relationship("User", foreign_keys=[resolved_by])
