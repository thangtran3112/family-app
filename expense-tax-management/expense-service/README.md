## Expense Service

FastAPI service owning expense-domain APIs, business logic, SQLAlchemy models, and Alembic migrations.

Run locally:

```bash
uv run uvicorn app.main:app --reload --port 8000
uv run python -m pytest tests/ -v --tb=short
uv run ruff check .
```

Shared transport contracts are provided by the editable `expense-contracts` package at `../common/python/expense-contracts`. SQLAlchemy models remain local to this service.
