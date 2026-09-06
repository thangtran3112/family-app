# Phase 3A — Temporal Workflow Setup (Python SDK)

> **Milestone**: 2 (Ingestion Pipeline & Auto-Tagging)
> **Dependencies**: Milestone 0 (MVP complete)
> **Estimated Effort**: 3-4 days

---

## Objective

Set up the Temporal.io workflow engine using the **Temporal Python SDK** (`temporalio>=1.8.0`) to migrate synchronous OCR, extraction, deduplication, and graph ingestion to durable, retryable async workflows.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│             TEMPORAL PYTHON ARCHITECTURE                 │
│                                                          │
│  ┌────────────────────┐        ┌───────────────────────┐ │
│  │ FastAPI App        │───────▶│ Temporal Server       │ │
│  │ (Workflow Client)  │ start  │ (Docker self-hosted)  │ │
│  └────────────────────┘ wflow  └──────────┬────────────┘ │
│                                           │              │
│                                           ▼              │
│                               ┌────────────────────────┐ │
│                               │ Temporal Python Worker │ │
│                               │ (backend/workers)      │ │
│                               │                        │ │
│                               │ Workflows:             │ │
│                               │ ├─ ProcessExpenseWflow │ │
│                               │ ├─ BatchProcessWflow   │ │
│                               │ └─ EmailScanWflow      │ │
│                               │                        │ │
│                               │ Activities:            │ │
│                               │ ├─ extract_ocr         │ │
│                               │ ├─ check_duplicate     │ │
│                               │ ├─ auto_tag            │ │
│                               │ ├─ upload_to_gcs       │ │
│                               │ ├─ generate_embedding  │ │
│                               │ └─ ingest_to_graph     │ │
│                               └────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

---

## Tasks

### 1. Temporal Server Setup

- [ ] Add Temporal server to `infrastructure/docker-compose.yml`:
  - `temporalio/auto-setup:latest`
  - PostgreSQL 17 as persistence store (separate database `temporal_db`)
  - Temporal Web UI on port 8233
- [ ] Configure namespace: `expense-management`
- [ ] Add health check verifying server accessibility

### 2. Temporal Python Worker Setup (`backend/workers/`)

- [ ] Add `temporalio>=1.8.0` to `backend/pyproject.toml`
- [ ] Create worker entrypoint `backend/workers/worker.py`:
  - Connect to Temporal server (`localhost:7233` or `temporal:7233` in Docker)
  - Register workflows and activities
  - Listen on task queue `expense-processing`
- [ ] Configure concurrency limits and activity retry policies

### 3. Expense Processing Workflow (`backend/workers/workflows/expense.py`)

- [ ] Define `ProcessExpenseWorkflow`:
  ```python
  from datetime import timedelta
  from temporalio import workflow

  @workflow.defn
  class ProcessExpenseWorkflow:
      @workflow.run
      async def run(self, input_data: dict) -> dict:
          tenant_id = input_data["tenant_id"]
          expense_id = input_data["expense_id"]
          file_id = input_data["file_id"]

          # 1. Budget check
          budget_ok = await workflow.execute_activity(
              "check_llm_budget",
              tenant_id,
              start_to_close_timeout=timedelta(seconds=10)
          )

          # 2. Extract OCR
          extracted = await workflow.execute_activity(
              "extract_ocr",
              {"file_id": file_id, "budget_ok": budget_ok},
              start_to_close_timeout=timedelta(seconds=60)
          )

          # 3. Check for duplicates
          dup_result = await workflow.execute_activity(
              "check_duplicate",
              {"tenant_id": tenant_id, "extracted": extracted},
              start_to_close_timeout=timedelta(seconds=15)
          )
          if dup_result.get("is_duplicate"):
              return {"status": "DUPLICATE", "match_id": dup_result["match_id"]}

          # 4. Auto-tag & categorize
          tags = await workflow.execute_activity(
              "auto_tag",
              {"tenant_id": tenant_id, "extracted": extracted},
              start_to_close_timeout=timedelta(seconds=30)
          )

          # 5. Ingest to Graphiti Knowledge Graph
          await workflow.execute_activity(
              "ingest_to_graph",
              {"tenant_id": tenant_id, "expense_id": expense_id, "extracted": extracted},
              start_to_close_timeout=timedelta(seconds=30)
          )

          return {"status": "REVIEW", "expense_id": expense_id}
  ```

### 4. Activities Implementation (`backend/workers/activities/`)

- [ ] `extract_ocr`: Calls `backend.app.services.ocr`
- [ ] `check_duplicate`: Computes content hash and queries pgvector
- [ ] `auto_tag`: Generates rule-based & LLM tags
- [ ] `upload_to_gcs`: Handles storage synchronization
- [ ] `ingest_to_graph`: Ingests episode natively into Graphiti

---

## Definition of Done

- [ ] Temporal server and worker start cleanly via Docker Compose
- [ ] Workflows can be triggered from FastAPI endpoint `POST /api/v1/expenses/upload`
- [ ] Execution visible with complete step history in Temporal Web UI (http://localhost:8233)
- [ ] Activity failures trigger exponential backoff retries automatically
