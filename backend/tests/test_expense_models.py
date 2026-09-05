from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category
from app.models.expense import Expense, ExpenseSource, ExpenseStatus, TaxDeductionType
from app.models.expense_file import ExpenseFile
from app.models.project import Project
from app.models.tag import ExpenseTag, Tag
from app.models.tenant import Tenant
from app.models.user import User


@pytest.mark.asyncio
async def test_create_expense_with_full_details(db_session: AsyncSession) -> None:
    tenant = Tenant(name="Acme Corp", slug="acme-corp")
    db_session.add(tenant)
    await db_session.commit()

    user = User(
        tenant_id=tenant.id,
        email="john@acme.com",
        name="John Doe",
        hashed_password="secretpassword",
        role="owner",
    )
    category = Category(tenant_id=tenant.id, name="Office Supplies")
    project = Project(tenant_id=tenant.id, name="Project Apollo", tax_year=2025)
    db_session.add_all([user, category, project])
    await db_session.commit()

    expense = Expense(
        tenant_id=tenant.id,
        user_id=user.id,
        category_id=category.id,
        project_id=project.id,
        title="Ergonomic Desk Chair",
        description="Office ergonomics upgrade",
        merchant="Herman Miller",
        amount=Decimal("895.50"),
        currency="USD",
        converted_amount=Decimal("895.50"),
        base_currency="USD",
        date=datetime.now(UTC),
        source=ExpenseSource.MANUAL,
        status=ExpenseStatus.COMPLETED,
        is_tax_deductible=True,
        tax_deduction_type=TaxDeductionType.BUSINESS,
        tax_deduction_percent=Decimal("100.00"),
        content_hash="hash-12345-abcde",
        ocr_raw_text="HERMAN MILLER INVOICE #9982 TOTAL: $895.50",
        ocr_confidence=0.98,
        ai_extracted_data={"merchant": "Herman Miller", "total": 895.50},
        line_items=[{"item": "Aeron Chair", "qty": 1, "price": 895.50}],
    )
    db_session.add(expense)
    await db_session.commit()

    # Retrieve and verify
    result = await db_session.execute(select(Expense).where(Expense.id == expense.id))
    retrieved = result.scalar_one()

    assert retrieved.merchant == "Herman Miller"
    assert retrieved.amount == Decimal("895.50")
    assert retrieved.is_tax_deductible is True
    assert retrieved.tax_deduction_percent == Decimal("100.00")
    assert retrieved.source == ExpenseSource.MANUAL
    assert retrieved.status == ExpenseStatus.COMPLETED
    assert retrieved.category_id == category.id
    assert retrieved.project_id == project.id
    assert retrieved.ai_extracted_data["total"] == 895.50


@pytest.mark.asyncio
async def test_expense_file_cascade_delete(db_session: AsyncSession) -> None:
    tenant = Tenant(name="File Test Tenant", slug="file-test-tenant")
    db_session.add(tenant)
    await db_session.commit()

    user = User(
        tenant_id=tenant.id,
        email="fileuser@test.com",
        name="File User",
        hashed_password="pw",
    )
    db_session.add(user)
    await db_session.commit()

    expense = Expense(
        tenant_id=tenant.id,
        user_id=user.id,
        title="Hardware Purchase",
        amount=Decimal("45.00"),
        date=datetime.now(UTC),
    )
    db_session.add(expense)
    await db_session.commit()

    file1 = ExpenseFile(
        expense_id=expense.id,
        user_id=user.id,
        original_filename="receipt.jpg",
        mime_type="image/jpeg",
        file_size=102400,
        cloud_storage_key=f"tenants/{tenant.id}/expenses/{expense.id}/receipt.jpg",
        cloud_storage_url="https://storage.googleapis.com/test-bucket/receipt.jpg",
    )
    db_session.add(file1)
    await db_session.commit()

    # Verify file exists
    files_result = await db_session.execute(
        select(ExpenseFile).where(ExpenseFile.expense_id == expense.id)
    )
    assert len(files_result.scalars().all()) == 1

    # Delete expense, check cascade
    await db_session.delete(expense)
    await db_session.commit()

    files_after = await db_session.execute(
        select(ExpenseFile).where(ExpenseFile.expense_id == expense.id)
    )
    assert len(files_after.scalars().all()) == 0


@pytest.mark.asyncio
async def test_expense_tag_association(db_session: AsyncSession) -> None:
    tenant = Tenant(name="Tag Assoc Tenant", slug="tag-assoc-tenant")
    db_session.add(tenant)
    await db_session.commit()

    user = User(
        tenant_id=tenant.id,
        email="taguser@test.com",
        name="Tag User",
        hashed_password="pw",
    )
    tag = Tag(tenant_id=tenant.id, name="tax-deductible-2025")
    db_session.add_all([user, tag])
    await db_session.commit()

    expense = Expense(
        tenant_id=tenant.id,
        user_id=user.id,
        title="Monitor Stand",
        amount=Decimal("35.00"),
        date=datetime.now(UTC),
    )
    db_session.add(expense)
    await db_session.commit()

    expense_tag = ExpenseTag(
        expense_id=expense.id,
        tag_id=tag.id,
        confidence=0.95,
        source="ai",
    )
    db_session.add(expense_tag)
    await db_session.commit()

    res = await db_session.execute(
        select(ExpenseTag).where(ExpenseTag.expense_id == expense.id)
    )
    et = res.scalar_one()
    assert et.tag_id == tag.id
    assert et.confidence == 0.95
    assert et.source == "ai"
