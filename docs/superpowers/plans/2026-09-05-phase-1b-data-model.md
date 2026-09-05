# Phase 1B — Core Data Model & Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete multi-tenant SQLAlchemy 2.0 data models, Alembic migrations (with pgvector and tsvector full-text search), and comprehensive model test suite for Phase 1B.

**Architecture:** 
- Modular domain models under `backend/app/models/`:
  - `category.py`: Default and tenant-custom expense categories
  - `project.py`: Small business / personal projects for tax deduction attribution
  - `tag.py`: User and auto-generated expense tags with confidence scores
  - `expense.py`: Core expense transaction record with source, status, tax deduction fields, content hash, pgvector embedding, and tsvector
  - `expense_file.py`: Receipt files (images, PDFs) with GCS keys and OCR text
  - `duplicate.py`: Cross-channel and manual deduplication match records
  - `llm_log.py`: LLM token usage and cost audit logs for monthly budget enforcement
- Database Migrations via Alembic with PostgreSQL 17, pgvector extension, and GIN indexes.
- Unit testing via `pytest` with in-memory SQLite (or test PostgreSQL container) verifying multi-tenant constraints, foreign keys, and cascading deletes.

**Tech Stack:** Python 3.13+, FastAPI, SQLAlchemy 2.0 (asyncpg), pgvector, Alembic, PostgreSQL 17, Pydantic v2, Pytest.

---

## Global Constraints

- **Multi-Tenancy**: Every business table must include `tenant_id: Mapped[uuid.UUID]` with a foreign key to `tenants.id` (`ondelete="CASCADE"`) and an index.
- **Async Execution**: All database operations must support asyncpg (`AsyncSession`).
- **PostgreSQL Native Features**: pgvector (`Vector(1536)`) and full-text search (`TSVECTOR`) on the `expenses` table.
- **Immutability of Audit**: `llm_usage_logs` must record all token costs for tenant monthly budget enforcement.

---

## Tasks

### Task 1: Category, Project, and Tag Models
- [ ] Create `backend/app/models/category.py` with `Category` model, tenant relationship, and unique constraint `(tenant_id, name)`.
- [ ] Create `backend/app/models/project.py` with `Project` model, business type, tax year, and unique constraint `(tenant_id, name)`.
- [ ] Create `backend/app/models/tag.py` with `Tag` and `ExpenseTag` models, including auto-generated flags and confidence scores.
- [ ] Update `backend/app/models/tenant.py` to add relationships for `categories`, `projects`, and `tags`.
- [ ] **Verification**: Write unit test in `backend/tests/test_taxonomy_models.py` verifying category, project, and tag creation and tenant isolation.

### Task 2: Expense and ExpenseFile Models
- [ ] Create `backend/app/models/expense.py` with:
  - Enums: `ExpenseSource` (`MANUAL`, `EMAIL`, `MANUAL_AND_EMAIL`), `ExpenseStatus` (`PENDING`, `PROCESSING`, `REVIEW`, `COMPLETED`, `DUPLICATE`, `ERROR`)
  - Amounts: `amount`, `currency`, `converted_amount`, `base_currency`
  - Tax fields: `is_tax_deductible`, `tax_deduction_type`, `tax_deduction_percent`
  - Search fields: `content_hash`, `embedding` (`Vector(1536)`), `search_vector` (`TSVECTOR`), `graph_node_id`
  - JSON metadata: `ocr_raw_text`, `ocr_confidence`, `ai_extracted_data`, `line_items`
  - Composite indexes on `(tenant_id, date)`, `(tenant_id, category_id)`, `(tenant_id, project_id)`, `(tenant_id, content_hash)`
- [ ] Create `backend/app/models/expense_file.py` with:
  - `original_filename`, `mime_type`, `file_size`
  - `local_path`, `cloud_storage_url`, `cloud_storage_key`, `thumbnail_url`
  - `ocr_text`
  - Cascade delete relationship with `Expense`
- [ ] Update `backend/app/models/tenant.py` and `backend/app/models/user.py` to link `expenses`.
- [ ] **Verification**: Write unit test in `backend/tests/test_expense_models.py` testing creation, relationship traversal, and cascading file deletion.

### Task 3: Deduplication and LLM Usage Log Models
- [ ] Create `backend/app/models/duplicate.py` with `DuplicateMatch` model:
  - `existing_expense_id`, `candidate_expense_id`, `match_type` (`content_hash`, `phash`, `semantic`, `order_number`), `confidence`, `resolution`
- [ ] Create `backend/app/models/llm_log.py` with `LlmUsageLog` model:
  - `tenant_id`, `user_id`, `provider`, `model`, `prompt_tokens`, `completion_tokens`, `total_cost_usd`, `operation`
- [ ] Expose all models in `backend/app/models/__init__.py`.
- [ ] **Verification**: Write unit test in `backend/tests/test_duplicate_llm_models.py` verifying audit logging and duplicate match records.

### Task 4: Alembic Migration
- [ ] Configure `backend/alembic/env.py` to import `app.models.Base` and include all models.
- [ ] Ensure `CREATE EXTENSION IF NOT EXISTS vector` is executed in migration.
- [ ] Generate migration script: `alembic revision --autogenerate -m "create_core_expense_schema"`.
- [ ] Add GIN index and tsvector trigger generation in the migration file.
- [ ] **Verification**: Run `alembic upgrade head` and verify schema in PostgreSQL.

### Task 5: Seed Default Categories and Test Suite Pass
- [ ] Create seeding utility (`backend/app/db/seed.py` or Alembic data migration) for standard tax deduction categories:
  - Office Supplies, Travel, Meals & Entertainment, Vehicle, Utilities, Home Office, Software & Subscriptions, Equipment.
- [ ] Run full backend test suite: `uv run pytest`.
- [ ] Run Ruff lint and format checks: `uv run ruff check .` and `uv run ruff format --check .`.

---

## Definition of Done

- [ ] All SQLAlchemy 2.0 models implemented with complete type annotations and docstrings.
- [ ] Multi-tenant isolation verified on all queries and foreign keys.
- [ ] Alembic migration applies cleanly to PostgreSQL with `pgvector` and `tsvector` enabled.
- [ ] 100% of unit tests pass in `backend/tests/`.
- [ ] Zero Ruff lint or format errors.
