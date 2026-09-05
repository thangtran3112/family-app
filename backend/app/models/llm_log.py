from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.expense import Expense
    from app.models.tenant import Tenant
    from app.models.user import User


class LlmUsageLog(Base):
    __tablename__ = "llm_usage_logs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )
    expense_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("expenses.id", ondelete="SET NULL"), index=True, nullable=True
    )

    operation: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # ocr_extraction, auto_tagging, query_planning, graph_extract
    provider: Mapped[str] = mapped_column(String(50), default="google", nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(8, 6), default=Decimal("0.000000"), nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )

    # Relationships
    tenant: Mapped[Tenant] = relationship("Tenant")
    user: Mapped[User | None] = relationship("User")
    expense: Mapped[Expense | None] = relationship("Expense")
