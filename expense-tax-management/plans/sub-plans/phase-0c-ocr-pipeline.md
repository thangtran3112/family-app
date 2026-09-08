# Phase 0C — Receipt Upload & OCR Pipeline

> **Replan required (2026-09-07)**: Do not implement the legacy synchronous FastAPI flow below. Revised Phase 0C depends on 0K, 0L, and revised 0D: App API creates an outbox-backed job, Foundry reserves a curated model quota, Python Temporal worker performs extraction, and App API accepts an idempotent result. See [Phase 0I sections 11 and 18-20](phase-0i-polyglot-platform-rebaseline-design.md).

> **Milestone**: 1 (Core Expense Management MVP)
> **Dependencies**: Phase 0B (Data Model)
> **Estimated Effort**: 4-5 days

---

## Objective

Implement receipt/invoice upload, OCR text extraction, and AI-powered structured data extraction via the Python FastAPI backend — the core value proposition of the app.

---

## Architecture

```
User uploads receipt via Next.js PWA (image/PDF)
         │
         ▼
┌─────────────────────┐
│  Upload API Route   │   POST /api/v1/expenses/upload (FastAPI)
│  (expense-service/app/api)  │   - Validate file type/size (UploadFile)
│  ├─ Temp local save │   - Save to temp storage (GCS in Phase 0D)
│  └─ Create Expense  │   - Create DB record via SQLAlchemy (status: PENDING)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  OCR Extraction     │   (Sync for MVP in expense-service/app/services/ocr.py)
│  ├─ OpenRouter/OpenAI│   - Send image/PDF to Vision LLM (or local PaddleOCR)
│  ├─ Extract text    │   - Raw OCR text extraction
│  └─ Parse structure │   - Extract: merchant, amount, date, items (Pydantic v2)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Post-Processing    │   (expense-service/app/services/processor.py)
│  ├─ Categorize      │   - Auto-assign category
│  ├─ Generate hash   │   - SHA-256 content hash for tenant dedup
│  ├─ Auto-tag        │   - Rule-based tags
│  └─ Update DB       │   - Update status to REVIEW
└─────────────────────┘
```

---

## Tasks

### 1. File Upload API (`expense-service/app/api/v1/expenses.py`)

- [ ] Create `POST /api/v1/expenses/upload` FastAPI route:
  - Accept `multipart/form-data` via `UploadFile` (JPEG, PNG, HEIC, WebP, PDF)
  - Validate file size (max 20MB) and mime type
  - Generate unique filename with UUID & timestamp
  - Save to temp local directory initially (GCS in Phase 0D)
  - Create `Expense` record in PostgreSQL with status `PENDING`
  - Create `ExpenseFile` record linked to expense
  - Return expense ID and initial status for client polling
- [ ] Create `POST /api/v1/expenses/batch-upload` for multi-file upload
- [ ] Handle HEIC to JPEG conversion via `pillow-heif` / Pillow

### 2. OCR & AI Extraction Service (`expense-service/app/services/ocr.py`)

- [ ] Set up unified AI extraction service with pluggable provider support:
  - **OpenRouter** (unified API access to multiple vision models: Claude, Llama 3 Vision, etc.)
  - **OpenAI** (`gpt-4o-mini` default cost-effective vision, `gpt-4o` for complex/degraded receipts)
  - **PaddleOCR** (native in-process Python option for zero-cost offline OCR)
  - *(Explicitly excluded: Google Gemini Flash)*
- [ ] Implement **Monthly LLM Budget Guard** (`expense-service/app/services/budget_guard.py`):
  - Pre-flight check: Compare `tenant.llm_monthly_used` against `tenant.llm_monthly_budget`
  - At **80% budget**: Record warning alert in system notifications
  - At **100% budget**: Block non-essential LLM calls, set expense status to `REVIEW` with note "LLM budget exceeded — manual entry required"
  - Post-call tracking: Log exact prompt/completion tokens and estimated USD cost to `LlmUsageLog`, update `tenant.llm_monthly_used`
- [ ] Define Pydantic v2 schemas (`expense-service/app/schemas/ocr.py` or `common/python/expense-contracts/` when shared):
  ```python
  from pydantic import BaseModel
  from typing import Optional, List

  class LineItem(BaseModel):
      description: str
      quantity: float = 1.0
      unit_price: float
      total_price: float
      category: Optional[str] = None

  class ExtractedExpenseData(BaseModel):
      merchant: Optional[str] = None
      amount: float
      currency: str = "USD"
      date: str  # ISO 8601
      items: List[LineItem] = []
      tax_amount: Optional[float] = None
      tax_rate: Optional[float] = None
      payment_method: Optional[str] = None
      receipt_number: Optional[str] = None
      raw_text: str = ""
      confidence: float = 1.0
  ```
- [ ] Design AI prompt template (inspired by TaxHacker):
  - System prompt for receipt understanding & itemization
  - Strict JSON output matching `ExtractedExpenseData` schema
  - Support custom user prompts (per category/project)
- [ ] Handle multi-page PDFs (extract text from all pages via `pypdfium2` or pdfplumber)
- [ ] Implement confidence scoring

### 3. Post-Processing & Deduplication Hash

- [ ] **Auto-categorization**: Match extracted merchant/items to user's categories
- [ ] Compute tenant-scoped SHA-256 `content_hash`:
  ```python
  import hashlib
  raw = f"{tenant_id}:{amount:.2f}:{date}:{merchant.lower().strip()}"
  content_hash = hashlib.sha256(raw.encode('utf-8')).hexdigest()
  ```
- [ ] Check for exact duplicate within tenant; flag if found
- [ ] Generate basic rule-based tags (store type, payment method)
- [ ] Update `Expense` record in PostgreSQL with status `REVIEW`

---

## Definition of Done

- [ ] `POST /api/v1/expenses/upload` accepts image/PDF and returns expense ID
- [ ] OCR extracts text and structured data (merchant, amount, date, line items)
- [ ] LLM budget guard warns at 80% and blocks at 100%
- [ ] Pydantic validation ensures strict response schemas
- [ ] Content hash is generated and indexed for tenant deduplication
- [ ] Next.js client can trigger upload and poll status until `REVIEW`
