import json
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import ValidationError

from expense_contracts import ExpenseCreate, ExpenseResponse, TaxDeductionType
from expense_contracts.generated.internal_messages import JobReferenceV1

JOB_REFERENCE_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages/contracts/fixtures/job-reference-v1.json"
    ).read_text()
)


def test_expense_create_accepts_transport_payload():
    expense = ExpenseCreate(
        user_id="user-1",
        title="Office chair",
        amount=Decimal("249.99"),
        date="2026-09-05",
    )

    assert expense.tax_deduction_type is TaxDeductionType.BUSINESS
    assert expense.tax_deduction_percent == Decimal("100.00")


def test_expense_create_rejects_non_positive_amount():
    with pytest.raises(ValidationError):
        ExpenseCreate(
            user_id="user-1",
            title="Invalid",
            amount=Decimal(0),
            date="2026-09-05",
        )


def test_expense_response_supports_from_attributes():
    response = ExpenseResponse.model_validate(
        {
            "id": "expense-1",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "title": "Office chair",
            "amount": Decimal("249.99"),
            "currency": "USD",
            "date": "2026-09-05",
            "source": "MANUAL",
            "status": "PENDING",
            "is_tax_deductible": True,
            "tax_deduction_type": "BUSINESS",
            "tax_deduction_percent": Decimal("100.00"),
            "created_at": "2026-09-05T00:00:00Z",
            "updated_at": "2026-09-05T00:00:00Z",
        }
    )

    assert response.id == "expense-1"


def test_generated_job_reference_accepts_canonical_fixture():
    model = JobReferenceV1.model_validate(JOB_REFERENCE_FIXTURE)

    assert model.model_dump(mode="json") == JOB_REFERENCE_FIXTURE


def test_generated_job_reference_rejects_extra_keys_and_malformed_uuid():
    with pytest.raises(ValidationError):
        JobReferenceV1.model_validate({**JOB_REFERENCE_FIXTURE, "extra": True})

    with pytest.raises(ValidationError):
        JobReferenceV1.model_validate({**JOB_REFERENCE_FIXTURE, "jobId": "invalid"})
