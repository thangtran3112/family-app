from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from expense_contracts.enums import ExpenseSource, ExpenseStatus, TaxDeductionType


class ExpenseCreate(BaseModel):
    """Transport contract for creating an expense."""

    user_id: str
    category_id: str | None = None
    project_id: str | None = None
    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    merchant: str | None = None
    amount: Decimal = Field(..., gt=0)
    currency: str = "USD"
    date: str
    source: ExpenseSource = ExpenseSource.MANUAL
    tax_deduction_type: TaxDeductionType = TaxDeductionType.BUSINESS
    tax_deduction_percent: Decimal = Field(default=Decimal("100.00"), ge=0, le=100)


class ExpenseResponse(BaseModel):
    """Transport contract for an expense response."""

    id: str
    tenant_id: str
    user_id: str
    category_id: str | None = None
    project_id: str | None = None
    title: str
    description: str | None = None
    merchant: str | None = None
    amount: Decimal
    currency: str
    date: str
    source: ExpenseSource
    status: ExpenseStatus
    is_tax_deductible: bool
    tax_deduction_type: TaxDeductionType
    tax_deduction_percent: Decimal
    content_hash: str | None = None
    ocr_raw_text: str | None = None
    ai_extracted_data: dict | None = None
    line_items: list[dict] | None = None
    embedding: list[float] | None = None
    search_vector: str | None = None
    graph_node_id: str | None = None
    created_at: str
    updated_at: str
    files: list | None = None
    tags: list | None = None

    model_config = ConfigDict(from_attributes=True)
