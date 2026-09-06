from expense_contracts import ExpenseCreate, ExpenseResponse


def test_expense_service_uses_shared_contracts():
    from app.schemas import ExpenseCreate as ServiceExpenseCreate
    from app.schemas import ExpenseResponse as ServiceExpenseResponse

    assert ServiceExpenseCreate is ExpenseCreate
    assert ServiceExpenseResponse is ExpenseResponse
