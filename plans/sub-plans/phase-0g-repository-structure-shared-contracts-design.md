# Repository Structure and Shared Contracts Design

**Date:** 2026-09-05

## Goal

Rename the presentation and service directories to reflect a growing microservice architecture, and introduce a reusable Python package for cross-service expense contracts without sharing database-owned ORM models.

## Approved Structure

```text
expense-tax-management/
├── frontend/
│   └── web/                         # Next.js PWA
├── expense-service/                 # FastAPI expense domain service
│   ├── app/                         # Service-owned application package
│   ├── alembic/                     # Service-owned migrations
│   └── tests/
├── common/
│   └── python/
│       └── expense-contracts/       # Installable shared Python package
│           ├── src/expense_contracts/
│           └── tests/
└── infrastructure/
```

## Boundary Decisions

### Shared package

`common/python/expense-contracts` owns stable cross-service contracts:

- Pydantic request/response DTOs for expense operations
- Expense-related string enums and other transport-safe value types
- Serialization and validation behavior that must remain consistent across Python services

The package has no SQLAlchemy, database, FastAPI, or service-internal dependencies.

### Expense service

`expense-service` continues to own:

- SQLAlchemy `Expense` and related ORM models
- `Base`, relationship mappings, database sessions, repositories, and Alembic migrations
- FastAPI route handlers and service-specific schemas
- OCR, storage, tax logic, and other expense-domain behavior

The SQLAlchemy model is intentionally not moved into `common/python`. ORM classes contain database table names, foreign keys, relationship graphs, dialect-specific types, metadata registration, and migration assumptions. Sharing them would make every future Python service coupled to the expense service database schema.

### Frontend contracts

The Next.js application continues consuming generated TypeScript types from the expense service OpenAPI document. Python contracts are not imported by TypeScript code.

## Migration Rules

- Rename `apps/` to `frontend/` and `backend/` to `expense-service/`.
- Update Docker, package-manager, OpenCode, README, plan, and test commands to use new paths.
- Keep the existing Python import package `app` inside `expense-service` to avoid an unrelated application-package rename.
- Make `expense-contracts` an editable local `uv` dependency of `expense-service`.
- Preserve current API field names and endpoint behavior while moving the reusable Pydantic expense DTOs.
- Keep current uncommitted work from other agents intact; do not reset or discard it.
- Do not create a branch.

## Validation

- `uv lock` succeeds in `expense-service` with the local shared package dependency.
- Shared package tests validate DTO construction, enum values, and rejection of invalid expense data.
- Expense-service tests import DTOs from `expense_contracts` and continue passing.
- `uv run ruff check .` and `uv run pytest tests/ -v --tb=short` pass from `expense-service`.
- `pnpm install --lockfile-only` succeeds from the repository root after the workspace path rename.
- `pnpm --filter web lint` and `pnpm --filter web build` pass from `frontend/web`.
- Docker Compose configuration resolves `expense-service` build context, volume, dependency, and network references.
