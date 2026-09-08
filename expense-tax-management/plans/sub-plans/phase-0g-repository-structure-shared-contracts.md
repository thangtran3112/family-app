# Repository Structure and Shared Contracts Implementation Plan

> **Historical plan update (2026-09-07)**: This completed migration documents current paths. Do not repeat its Python-first contract tasks. Phase 0I replaces manual Pydantic source ownership with Zod-generated transport artifacts and introduces `services/app-api`, `services/foundry-service`, and `services/ai-worker`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the monorepo application directories and establish an installable shared Python expense-contracts package while keeping SQLAlchemy models owned by `expense-service`.

**Architecture:** Rename `apps/` to `frontend/` and `backend/` to `expense-service/`, then update all tooling and infrastructure references. Create `common/python/expense-contracts` as a dependency-free-from-ORM Pydantic package; `expense-service` consumes it through an editable local `uv` source. Keep `Expense` and all related SQLAlchemy models in `expense-service/app/models/`.

**Tech Stack:** Python 3.13+, uv, Pydantic v2, FastAPI, SQLAlchemy 2.0, Alembic, pytest, Ruff, pnpm 11, Next.js 16, Docker Compose.

**Spec:** `plans/sub-plans/phase-0g-repository-structure-shared-contracts-design.md`

## Global Constraints

- No feature branch; work on current `main` branch.
- Preserve uncommitted changes from other agents; never reset or discard them.
- `expense-service` owns SQLAlchemy models, database metadata, repositories, and Alembic migrations.
- `common/python/expense-contracts` contains Pydantic DTOs and transport-safe enums only; no SQLAlchemy or FastAPI dependency.
- Preserve current API field names and endpoint behavior during this structural migration.
- All expense-service database queries remain tenant-scoped.
- Frontend remains presentation-only and consumes generated OpenAPI TypeScript types.

## File Map

- Rename: `apps/` -> `frontend/`
- Rename: `backend/` -> `expense-service/`
- Create: `common/python/expense-contracts/pyproject.toml`
- Create: `common/python/expense-contracts/src/expense_contracts/__init__.py`
- Create: `common/python/expense-contracts/src/expense_contracts/expense.py`
- Create: `common/python/expense-contracts/src/expense_contracts/enums.py`
- Create: `common/python/expense-contracts/tests/test_expense_contracts.py`
- Remove after migration: `expense-service/app/schemas/expense.py`
- Modify: `expense-service/app/schemas/__init__.py` to re-export shared DTOs
- Modify: `expense-service/pyproject.toml` and `expense-service/uv.lock`
- Modify: root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Modify: `infrastructure/docker-compose.yml`
- Modify: `opencode.json`, `.opencode/README.md`, `.opencode/rules/*`
- Modify: `AGENTS.md`, `plans/PLAN.md`, active plan/sub-plan path references, and service/frontend READMEs

### Task 1: Add shared expense contracts package

**Files:**
- Create: `common/python/expense-contracts/pyproject.toml`
- Create: `common/python/expense-contracts/src/expense_contracts/__init__.py`
- Create: `common/python/expense-contracts/src/expense_contracts/enums.py`
- Create: `common/python/expense-contracts/src/expense_contracts/expense.py`
- Create: `common/python/expense-contracts/tests/test_expense_contracts.py`

**Interfaces:**
- Produces `expense_contracts.ExpenseCreate`
- Produces `expense_contracts.ExpenseResponse`
- Produces `expense_contracts.ExpenseSource`, `ExpenseStatus`, and `TaxDeductionType`

- [ ] **Step 1: Write failing shared-package tests**

```python
from decimal import Decimal

import pytest
from pydantic import ValidationError

from expense_contracts import ExpenseCreate, ExpenseResponse, TaxDeductionType


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
            amount=Decimal("0"),
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
```

- [ ] **Step 2: Run tests to verify they fail before package exists**

Run: `cd common/python/expense-contracts && uv run python -m pytest -q`

Expected: FAIL because `expense_contracts` is not implemented.

- [ ] **Step 3: Implement package metadata and contracts**

Use a `src` layout. `pyproject.toml` must declare:

```toml
[project]
name = "expense-contracts"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["pydantic>=2.10.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/expense_contracts"]

[tool.pytest.ini_options]
pythonpath = ["src"]
```

Move the existing expense DTO field set without changing API names. Define enums as `str, enum.Enum` values matching the current database/API values. Set `ExpenseResponse.model_config = {"from_attributes": True}`. Do not import `app`, SQLAlchemy, FastAPI, or database types.

- [ ] **Step 4: Run shared-package tests and Ruff**

Run: `cd common/python/expense-contracts && uv run python -m pytest -q && uv run ruff check src tests`

Expected: all tests pass and Ruff reports no errors.

- [ ] **Step 5: Commit the isolated package task**

```bash
git add common/python/expense-contracts
git commit -m "feat: add shared expense contracts"
```

### Task 2: Rename application directories and package-manager paths

**Files:**
- Rename: `apps/` -> `frontend/`
- Rename: `backend/` -> `expense-service/`
- Modify: root `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml` through `pnpm install --lockfile-only`

**Interfaces:**
- Produces canonical frontend path `frontend/web`
- Produces canonical service path `expense-service`

- [ ] **Step 1: Verify rename targets are cleanly addressable**

Run: `test -d apps/web && test -d backend && test ! -e frontend && test ! -e expense-service`

Expected: command exits successfully before the rename.

- [ ] **Step 2: Rename directories without changing file contents**

Run: `mv apps frontend` and `mv backend expense-service`.

Do not rename the internal Python package `app`; its import paths remain `from app...` inside `expense-service`.

- [ ] **Step 3: Update root package scripts and workspace glob**

Set root scripts to use `frontend/web` and `expense-service`:

```json
{
  "dev:frontend": "pnpm --filter web dev",
  "build:frontend": "pnpm --filter web build",
  "lint:frontend": "pnpm --filter web lint",
  "gen:api": "pnpm --filter web gen:api",
  "expense-service:dev": "cd expense-service && uv run uvicorn app.main:app --reload --port 8000",
"expense-service:test": "cd expense-service && uv run python -m pytest"
}
```

Replace the workspace pattern with `frontend/*`. Do not retain `backend:*` aliases; this is an internal repository rename.

- [ ] **Step 4: Regenerate the pnpm lockfile and verify workspace discovery**

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` uses `frontend/web` importer path and `pnpm --filter web` still resolves the package.

- [ ] **Step 5: Commit directory and workspace rename**

```bash
git add frontend expense-service package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "refactor: rename app and service directories"
```

### Task 3: Wire shared contracts into expense-service

**Files:**
- Modify: `expense-service/pyproject.toml`
- Modify: `expense-service/uv.lock`
- Modify: `expense-service/app/schemas/__init__.py`
- Delete: `expense-service/app/schemas/expense.py`
- Modify: `expense-service/app/api/v1/expenses.py`
- Test: `expense-service/tests/test_shared_contracts.py`

**Interfaces:**
- Consumes `expense_contracts` from Task 1
- Preserves `from app.schemas import ExpenseCreate, ExpenseResponse` for service-local callers
- Produces no shared SQLAlchemy model dependency

- [ ] **Step 1: Write failing service integration test**

```python
from expense_contracts import ExpenseCreate, ExpenseResponse


def test_expense_service_uses_shared_contracts():
    from app.schemas import ExpenseCreate as ServiceExpenseCreate
    from app.schemas import ExpenseResponse as ServiceExpenseResponse

    assert ServiceExpenseCreate is ExpenseCreate
    assert ServiceExpenseResponse is ExpenseResponse
```

- [ ] **Step 2: Run test to verify local dependency is missing**

Run: `cd expense-service && uv run python -m pytest tests/test_shared_contracts.py -q`

Expected: FAIL because `expense-contracts` is not declared as a service dependency.

- [ ] **Step 3: Add editable local uv source**

Add to `expense-service/pyproject.toml`:

```toml
dependencies = [
    "expense-contracts",
    # existing dependencies remain unchanged
]

[tool.uv.sources]
expense-contracts = { path = "../common/python/expense-contracts", editable = true }
```

Run: `cd expense-service && uv lock`

- [ ] **Step 4: Re-export shared DTOs from the service schema facade**

Change `expense-service/app/schemas/__init__.py` to import `ExpenseCreate` and `ExpenseResponse` from `expense_contracts`. Remove the duplicate local `app/schemas/expense.py`. Update `expense-service/app/api/v1/expenses.py` to import directly from `expense_contracts` or the facade consistently; prefer direct shared-package imports for new code.

Do not move `expense-service/app/models/expense.py` or any related ORM model. Keep all SQLAlchemy model imports under `app.models`.

- [ ] **Step 5: Run service tests and static checks**

Run: `cd expense-service && uv run python -m pytest tests/test_shared_contracts.py -q && uv run ruff check .`

Expected: integration test passes and Ruff reports no errors.

- [ ] **Step 6: Commit shared dependency integration**

```bash
git add expense-service/pyproject.toml expense-service/uv.lock expense-service/app/schemas expense-service/app/api/v1/expenses.py expense-service/tests/test_shared_contracts.py
git commit -m "refactor: consume shared expense contracts"
```

### Task 4: Rename infrastructure and developer tooling references

**Files:**
- Modify: `infrastructure/docker-compose.yml`
- Modify: `opencode.json`
- Modify: `.opencode/README.md`
- Modify: `.opencode/rules/backend.rules` or rename it to `.opencode/rules/expense-service.rules`
- Modify: `.opencode/rules/frontend.rules`
- Modify: root `AGENTS.md`
- Modify: `expense-service/README.md`
- Modify: `frontend/web/README.md` only where paths are documented

- [ ] **Step 1: Update Docker Compose service identity**

Rename the Compose service key from `backend` to `expense-service`, change build context and bind mount to `../expense-service`, update `depends_on` and Nginx upstream references, and rename the container to `expense-tax-expense-service`. Preserve the container port and API behavior.

- [ ] **Step 2: Update OpenCode configuration**

Rename `opencode.json` fields from generic `backend` to `expenseService`, set service paths to `expense-service`, frontend paths to `frontend/web`, and add the shared package path `common/python/expense-contracts`.

- [ ] **Step 3: Update repository guidance**

Update `AGENTS.md` directory tables and commands from `apps/web`/`backend` to `frontend/web`/`expense-service`. Describe the shared package boundary and explicitly state that SQLAlchemy models remain service-owned. Rename the backend rule file to an expense-service-specific name if no external tooling depends on its filename.

- [ ] **Step 4: Search for stale paths**

Run: `rg -n --hidden --glob '!**/.git/**' --glob '!**/.next/**' --glob '!**/.venv/**' '(?<![A-Za-z])apps/|(?<![A-Za-z])backend/' .`

Expected: no stale operational path references remain. Historical prose may retain the word “backend” only when it is a conceptual layer rather than a filesystem/service name; update concrete paths and commands.

- [ ] **Step 5: Commit infrastructure and guidance updates**

```bash
git add infrastructure opencode.json .opencode AGENTS.md expense-service/README.md frontend/web/README.md
git commit -m "docs: align tooling with service naming"
```

### Task 5: Verify full repository migration and update Phase 0 tracking

**Files:**
- Modify: `plans/PLAN.md`
- Modify: active `plans/sub-plans/*.md` path references
- Test: `expense-service/tests/test_shared_contracts.py`, existing service tests, frontend checks

- [ ] **Step 1: Update active plan paths and Phase 0 status**

Add Phase `0G — Repository Structure & Shared Python Contracts` to `plans/PLAN.md`, link this implementation plan, and mark it `✅ Complete` only after all validation steps pass. Update concrete path references in active plans from `backend/` to `expense-service/` and `apps/web/` to `frontend/web/`.

- [ ] **Step 2: Validate shared package and expense service**

Run from `expense-service`:

```bash
uv run ruff check .
uv run python -m pytest tests/ -v --tb=short
```

Expected: both commands pass. If existing unrelated uncommitted-agent code fails, record the exact failure and do not revert it.

- [ ] **Step 3: Validate frontend**

Run from the repository root:

```bash
pnpm --filter web lint
pnpm --filter web build
```

Expected: both commands pass from the renamed workspace.

- [ ] **Step 4: Validate Compose configuration**

Run: `docker compose -f infrastructure/docker-compose.yml config`

Expected: configuration renders successfully with `expense-service` paths and service references.

- [ ] **Step 5: Validate final path and import invariants**

Run:

```bash
test -d frontend/web
test -d expense-service
test -f common/python/expense-contracts/pyproject.toml
test ! -d apps
test ! -d backend
cd expense-service && uv run python -c "from expense_contracts import ExpenseCreate; from app.models.expense import Expense; print(ExpenseCreate.__name__, Expense.__name__)"
```

Expected: all commands succeed; shared DTO and service-owned ORM model import independently.

- [ ] **Step 6: Commit tracking updates**

```bash
git add plans/PLAN.md plans/sub-plans
git commit -m "docs: track repository structure migration"
```

## Definition of Done

- [ ] `apps/` is renamed to `frontend/` and all operational references use `frontend/web`.
- [ ] `backend/` is renamed to `expense-service/` and all operational references use `expense-service`.
- [ ] `common/python/expense-contracts` is an installable Pydantic package consumed through an editable local uv dependency.
- [ ] Expense DTOs and enums are reusable from `expense_contracts`.
- [ ] SQLAlchemy `Expense` and related models remain inside `expense-service`.
- [ ] Frontend workspace, Docker Compose, OpenCode config, guidance, plans, and commands use new names.
- [ ] Shared-package tests, expense-service tests, Ruff, frontend lint/build, and Compose config validation pass.
- [ ] Phase 0 task status in `plans/PLAN.md` reflects actual completion.
