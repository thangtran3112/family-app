from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.duplicate import DuplicateMatch
from app.models.expense import Expense
from app.models.llm_log import LlmUsageLog
from app.models.tenant import Tenant
from app.models.user import User


@pytest.mark.asyncio
async def test_duplicate_match_lifecycle(db_session: AsyncSession) -> None:
    tenant = Tenant(name="Dedup Tenant", slug="dedup-tenant")
    db_session.add(tenant)
    await db_session.commit()

    user = User(
        tenant_id=tenant.id,
        email="dedup@test.com",
        name="Dedup User",
        hashed_password="pw",
    )
    db_session.add(user)
    await db_session.commit()

    # Create two expenses that look similar
    exp1 = Expense(
        tenant_id=tenant.id,
        user_id=user.id,
        title="Costco Receipt #1",
        merchant="Costco",
        amount=Decimal("152.40"),
        date=datetime.now(UTC),
        content_hash="hash-costco-1",
    )
    exp2 = Expense(
        tenant_id=tenant.id,
        user_id=user.id,
        title="Costco Order Email",
        merchant="Costco",
        amount=Decimal("152.40"),
        date=datetime.now(UTC),
        content_hash="hash-costco-2",
    )
    db_session.add_all([exp1, exp2])
    await db_session.commit()

    # Create duplicate match record
    dup = DuplicateMatch(
        tenant_id=tenant.id,
        existing_expense_id=exp1.id,
        candidate_expense_id=exp2.id,
        match_type="content_hash",
        confidence=0.99,
        status="PENDING",
        details={"matched_fields": ["merchant", "amount", "date"]},
    )
    db_session.add(dup)
    await db_session.commit()

    result = await db_session.execute(
        select(DuplicateMatch).where(DuplicateMatch.id == dup.id)
    )
    match = result.scalar_one()
    assert match.existing_expense_id == exp1.id
    assert match.candidate_expense_id == exp2.id
    assert match.confidence == 0.99
    assert match.status == "PENDING"
    assert match.details["matched_fields"] == ["merchant", "amount", "date"]


@pytest.mark.asyncio
async def test_llm_usage_log(db_session: AsyncSession) -> None:
    tenant = Tenant(
        name="LLM Tenant",
        slug="llm-tenant",
        llm_monthly_budget=Decimal("50.00"),
        llm_monthly_used=Decimal("0.00"),
    )
    db_session.add(tenant)
    await db_session.commit()

    user = User(
        tenant_id=tenant.id,
        email="llmuser@test.com",
        name="LLM User",
        hashed_password="pw",
    )
    db_session.add(user)
    await db_session.commit()

    log_entry = LlmUsageLog(
        tenant_id=tenant.id,
        user_id=user.id,
        operation="ocr_extraction",
        provider="google",
        model="gemini-2.5-pro",
        prompt_tokens=1500,
        completion_tokens=320,
        total_tokens=1820,
        cost_usd=Decimal("0.004250"),
    )
    db_session.add(log_entry)
    await db_session.commit()

    res = await db_session.execute(
        select(LlmUsageLog).where(LlmUsageLog.tenant_id == tenant.id)
    )
    saved_log = res.scalar_one()
    assert saved_log.operation == "ocr_extraction"
    assert saved_log.model == "gemini-2.5-pro"
    assert saved_log.total_tokens == 1820
    assert saved_log.cost_usd == Decimal("0.004250")
