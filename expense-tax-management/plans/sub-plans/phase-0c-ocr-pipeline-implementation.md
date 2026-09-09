# Phase 0C Implementation Plan: Receipt Capture → OCR Extraction → Expense

Source of truth: [phase-0i-polyglot-platform-rebaseline-design.md](phase-0i-polyglot-platform-rebaseline-design.md)
§11 (Foundry quotas), §16.3–16.4 (internal APIs, worker callbacks), §18
(reliability, trace chain), §22 (fake-provider e2e gate). Replaces
[phase-0c-ocr-pipeline.md](phase-0c-ocr-pipeline.md), which carries its own
replan notice (legacy sync FastAPI flow — do not implement).

Depends on 0K (quotas/reservations), 0L (worker foundation, job substrate),
0D (files/storage) — all complete.

## Scope

End-to-end receipt OCR with a **fake provider** (design doc §22 gate:
"Fake-provider end-to-end flow covers App API, Foundry, Temporal, Python
worker, and GCS" — here GCS means the 0D storage seam, proven by the
local adapter). No real vision-LLM exists in this environment (no provider
keys, no Secret Manager); a real adapter is a later phase once credentials
exist. The fake exercises the REAL reservation lifecycle, REAL quota
accounting, REAL Temporal orchestration, REAL file download, and REAL
expense creation — only the provider's "eyes" are stubbed.

In scope:
- Tenant OCR job creation (mode-gated by App API-owned entitlements).
- Foundry `effective-route` read endpoint + `fake` provider kind + seed
  catalog (fake connection/model/modes/routes).
- Python `OcrReceiptWorkflow` + Foundry client + fake extraction provider.
- Extraction-apply inside App API's `submitResult` (creates the expense
  atomically with the job update; binds file ↔ expense ↔ job).
- Tenant job polling (list jobs per file).
- `QUOTA_BLOCKED` typed failure + exhaustion e2e.
- `source: "ocr"` on expenses (migration).

Out of scope (explicitly deferred, documented below):
- App-signed admission grants (§16.3 sentence) — hardening gap, tracked
  pre-release. Worker reserves via existing service-scoped endpoints.
- Reservation→route-version audit linkage (§11.4 "fixes immutable route
  version") — same Foundry-hardening bucket as grants.
- Upfront App API→Foundry quota-status check at job creation — needs
  service-token acquisition, out of scope since 0K Wave B; worker-side
  reserve is the enforcement point.
- Dedup hash (3B), category suggestion (3C), budget guard beyond quotas,
  re-OCR of bound files, expense attach-then-extract backfill.

## Key decisions (locked, not re-litigated)

1. **Extraction creates the expense; no placeholder drafts.** `submitResult`
   with `resultSchemaVersion "ocr-extraction-v1"` + `targetAggregateType
   "expense"` + status SUCCEEDED creates the expense in the SAME
   transaction as the job update. Failed jobs leave no expense row.
   (Placeholder drafts would lie in the ledger when OCR fails.)
2. **Two nullable columns on `processing_jobs`** (migration 010):
   `requested_by_user_id` (expense `created_by` attribution; §10
   "usage records retain initiating user ID") and `source_file_id`
   (job→file link). Trace chain without touching the expenses table:
   `file.expense_id` → expense, `job.target_aggregate_id` (backfilled at
   apply) → expense, `job.source_file_id` → file.
3. **New expense `source: "ocr"`** (migration widens CHECK; contract enum
   widens). OCR-created rows must not masquerade as `manual`.
4. **OCR jobs rejected for already-bound files.** `file.expense_id IS NOT
   NULL` → 409 on job creation (already extracted; re-OCR is future).
   Pre-bound (attach-then-extract) files also rejected in 0C — no caller
   binds files yet, so this only triggers for previously-OCR'd files.
5. **No numeric RECEIPT_OCR entitlement mapping in sync.** ocr_mode_* are
   unlimited booleans; missing Foundry policy = uncapped (existing
   `checkAndReserve` semantics). Mapping unlimited→unlimited changes
   nothing. Mode gating (boolean) stays App API-side.
6. **Tenant sees jobs via file-scoped listing**, not a job-status route:
   `GET .../files/:fileId/ocr-jobs` returns the file's jobs (status,
   errorMessage). File → expenseId appears when extraction lands.
7. **`QUOTA_BLOCKED` is a message-prefix convention**: job FAILED +
   `errorMessage "QUOTA_BLOCKED: ..."` (+ enabled-mode alternatives in
   text). No new job status (closed set is a Wave-0L invariant).
8. **Fake extraction is canned + deterministic** (fixed merchant/amount/
   date), but downloads REAL bytes and verifies sha256 against the
   file's stored hash first — the download + integrity path is real.
9. **Nested-transaction rule**: `createPersonal/createBusiness` open their
   own transactions, so the applier CANNOT call them inside submitResult's
   transaction. Refactor: `insertExpense` gains `source`/`initialStatus`
   params (defaults preserve behavior); export transaction-scoped
   `insertExpenseInTransaction` for the applier. Single insert with
   status `ready` (no create-then-update round trip).

## Contracts (`packages/contracts`)

New `src/ocr.ts` (exported from index):
- `OcrModeKeySchema = z.enum(["ocr_mode_fast","ocr_mode_balanced","ocr_mode_accurate"])`
- `OcrExtractionResultV1Schema` (+ type): `{ schemaVersion: literal(1),
  merchant: 1–200, amount: DecimalMoneySchema (reuse), currency:
  CurrencySchema (reuse), incurredOn: DateOnlySchema (reuse), notes?:
  max 2000, confidence: 0–1 }` — also added to the 0L JSON-schema→Pydantic
  loop (generate-json-schema.ts + generate-python.sh + check-generated
  pairs + generated/__init__ re-export).
- `OcrJobInputV1Schema`: `{ schemaVersion: 1, fileId: uuid, modeKey:
  OcrModeKeySchema, expectedSha256: 64-hex|null, tenantId: uuid }` —
  tenantId flows App API → worker → Foundry reserve; tampering requires
  worker-token compromise (the exact gap grants will close; documented).
  Also in the Pydantic loop (worker parses job input with it).
- `CreateOcrJobRequestSchema = { modeKey: OcrModeKeySchema }`
- `EffectiveRouteResponseSchema` (in foundry-catalog.ts): `{ aiModeId,
  routeVersionId, routeVersionNumber, aiModelId, providerKind,
  providerModelId }` — no secrets (worker needs kind + raw model ID to
  call; secrets arrive via Secret Manager route-scoped reads, future).
- `ExpenseSourceSchema`: literal → `z.enum(["manual","ocr"])`.
- Constants (task-queues.ts, mirrored in Python per 0L pattern):
  `OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow"`,
  `OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1"`.

## App API

Migration `010_ocr_expenses.ts`:
- `ALTER TABLE app.expenses DROP CONSTRAINT expenses_source_check,
  ADD CONSTRAINT ... CHECK (source IN ('manual','ocr'))`.
- `ALTER TABLE app.processing_jobs ADD COLUMN requested_by_user_id uuid
  NULL REFERENCES app.users(id), ADD COLUMN source_file_id uuid NULL
  REFERENCES app.expense_files(id) ON DELETE SET NULL` + index on
  `source_file_id`.

`src/domain/ocr.ts` — `createOcrJobsDomain(database, { plansDomain,
processingJobsDomain, filesDomain })`:
- `createOcrJob({ actorUserId, tenantId, scope, fileId, modeKey,
  idempotencyKey, requestId })`:
  membership write-check via filesDomain.getFile (throws NOT_FOUND/
  FORBIDDEN as appropriate — reuse, don't re-implement);
  file must be READY (else 409) and `expense_id IS NULL` (else 409);
  `plansDomain.resolveEffectiveEntitlements` → modeKey entry `isEnabled`
  (else 403);
  `processingJobsDomain.createJob` with workflowType
  OcrReceiptWorkflow, taskQueue AI_WORKER_TASK_QUEUE,
  allowedResultSchemaVersion ocr-extraction-v1, targetAggregateType
  "expense", targetAggregateId null, sourceFileId, requestedByUserId.
  Wrapped in `executeIdempotentMutation` (actorKey user, op
  "ocr-job.create", hash covers tenant+scope+file+mode).
- `listOcrJobs({ actorUserId, tenantId, scope, fileId })`: membership
  read-check (getFile), then list jobs by source_file_id newest-first.
- `getOcrInput({ jobId, actorServicePrincipal })`: load job (any status?
  require DISPATCHED/RUNNING — input for a PENDING job is meaningless;
  terminal job input is harmless but pointless: allow DISPATCHED+,
  reject PENDING with 409); require workflowType OcrReceiptWorkflow
  (else 404 — this endpoint serves OCR jobs only); load file;
  return `{ schemaVersion 1, fileId, modeKey, expectedSha256,
  tenantId }`. Where does modeKey come from? NOWHERE on the job row!
  ... The job doesn't store modeKey. Options: (a) new column, (b) derive
  — can't. ADD `job_metadata jsonb NULL`? Hmm. Third new column feels
  sloppy. Alternative: modeKey → model resolution happens at CREATION?
  No (route may flip between create and dispatch — pinning at creation
  is actually GOOD: immutable route pin... but needs Foundry read
  App API-side — the deferred proxy again).
  Decision: store `modeKey` in... let me think. Cleanest minimal: the
  ocr-input response derives modeKey from the tenant's CURRENT enabled
  modes? NO — must be the REQUESTED mode (quota/audit fidelity).
  OK: add `operation_params jsonb NULL`? Still a column. You know what —
  a `source_file_id` precedent exists now; job rows are allowed to carry
  creation context. But rather than one column per future need, add ONE
  `input_params jsonb NOT NULL DEFAULT '{}'`... changes 0L insert (must
  supply). Hmm, 0L's createJob signature change (new optional field
  `inputParams?: Record<string, JsonValue>`) — backward compatible
  (optional, defaults {}). ocr creation passes `{ modeKey }`. ocr-input
  reads `job.input_params.modeKey` (validate enum, else fail closed).
  This is the generic escape hatch future workflows reuse. DO THAT.
  (Also useful for 0P/3C later.)

`src/domain/processing-jobs.ts`:
- `createJob` accepts optional `inputParams?: Record<string, unknown>`
  (serialized via toJsonValue, defaults `{}`); `toProcessingJob`
  surfaces it. New `CreateProcessingJobInput` fields: `requestedByUserId?`,
  `sourceFileId?`, `inputParams?`.
- `submitResult`: after version/transition/schema checks, if
  `status === SUCCEEDED && resultSchemaVersion ===
  "ocr-extraction-v1" && targetAggregateType === "expense"` → parse
  result as OcrExtractionResultV1 (failure → validation error) →
  `applyOcrExtraction(transaction, { job, extraction, requestId })`
  (imported from ocr.ts — same-service, type-only back-import avoided
  by defining applier input against row types). FAILED results skip
  apply (stored only). If applier absent... no — direct import, always
  present; unknown future schema versions already 400 via version check.
  Non-ocr jobs (targetAggregateType null/other) skip apply entirely.

`src/domain/ocr.ts` applier `applyOcrExtraction(transaction, { job,
extraction, requestId })`:
- job.requested_by null → validation (fail closed).
- `insertExpenseInTransaction` (new export from expenses.ts) with source
  "ocr", initialStatus "ready", scope from JOB row (not caller input —
  §16.4: caller targets ignored), created_by = requested_by,
  description = notes ?? null.
- backfill job.target_aggregate_id = expense.id (UPDATE jobs WHERE id).
- bind file: `UPDATE expense_files SET expense_id WHERE id =
  source_file_id AND expense_id IS NULL` (no clobber).
- audit "expense.created" comes from insertExpense; add applier-level
  audit? insertExpense already audits. Enough.

`src/domain/expenses.ts` refactor:
- `insertExpense` input += `source?: "manual"|"ocr"`,
  `initialStatus?: "draft"|"ready"` (defaults manual/draft — existing
  callers untouched); export `insertExpenseInTransaction` (same fn,
  exported wrapper or direct export).

Routes (`src/routes/ocr.ts`, tenant auth pattern from files.ts):
- `POST .../personal-profiles/:profileId/files/:fileId/ocr-jobs` +
  business mirror; headers idempotency-key; body CreateOcrJobRequest;
  201 ProcessingJob; 403 disabled mode / 409 file state.
- `GET .../files/:fileId/ocr-jobs` (+ mirror) → `{ items: ProcessingJob[] }`
  (new `OcrJobListSchema` in contracts).
- `GET /internal/v1/jobs/:jobId/ocr-input` ai-worker scoped (new scope?
  reuse `jobs:write` — input-read is part of the write flow; new scope
  `jobs:read`... 0L gave worker ONLY jobs:write. Input reading is a
  read — but minting a second scope doubles test matrix for zero security
  gain (same principal, same jobs). REUSE `jobs:write` with comment.)
- Wire `createOcrJobsDomain` in app.ts; pass through to routes.

## Foundry

Migration `004_fake_ocr_provider.ts`:
- Widen kind CHECK to include `'fake'`.
- Seed (fixed UUIDs, `ON CONFLICT DO NOTHING` per 0J1 precedent):
  `provider_secrets` row (value `fake-provider-no-credential` — inert,
  documented), `provider_connections` (`fake-ocr`, kind fake, display
  "Fake OCR (dev/test only)"), `ai_models` (provider_model_id
  `fake-ocr-v1`, metered `fake-ocr`), THREE `ai_modes` (keys
  ocr_mode_fast/balanced/accurate, operation RECEIPT_OCR) each with
  route v1 (is_current) → fake model. One fake backend behind three
  curated names — mode-SEPARATE quotas still enforceable per mode key?
  No — modes share one model; model-scoped policies are per aiModelId
  (shared). Aggregate RECEIPT_OCR policies are per (tenant, operation)
  — mode-independent. Mode differences are future-real-provider work.
- ProviderKindSchema += "fake".

`src/domain/routes.ts` (new) `resolveEffectiveRoute({ operation, modeKey })`:
mode (key+operation+active) → current route (is_current) → model
(active) + connection (active) → EffectiveRouteResponse. Anything
missing/inactive → notFound (no existence oracle — same NOT_FOUND for
all misses, matching codebase philosophy).

Route `GET /internal/v1/effective-route?operation=&modeKey=`
`serviceGuard("ai-worker", ["routes:read"])` (new scope string).
Query schema in foundry-quotas.ts (or catalog): operation enum +
modeKey CatalogKey-ish string.

Unit (`test/effective-route.test.ts`) + integration
(`test/integration/foundry-domain-routes.test.ts`, PHASE_0K_WAVE_A-style
flag? new flag PHASE_0C_INTEGRATION covers both services' 0C tests —
simpler: one flag for all 0C integration).

## Python worker (`services/ai-worker`)

- `foundry_client.py`: `FoundryClient(base_url, service_token)` —
  `get_effective_route(operation, mode_key)`,
  `reserve(tenant_id, operation, ai_model_id, idempotency_key)`,
  `mark_call_started(reservation_id, provider_idempotency_key?)`,
  `record_outcome(reservation_id, attempt_number, outcome, ...)`,
  `release(reservation_id)`. httpx, exclude_none=True (0L lesson),
  `.env`: FOUNDRY_BASE_URL, FOUNDRY_SERVICE_TOKEN.
- `ocr_activities.py` `OcrReceiptActivities(app_api, foundry)`:
  reuse `mark_running` shape (own input structs per 0L pattern):
  1. `mark_running` (reuse FoundationEcho's? It's bound-method on a
     different class with same name "mark_running" — Temporal activity
     TYPE names must be unique per worker! FoundationEcho registers
     "mark_running"/"submit_echo_result". OCR needs DISTINCT type names:
     "ocr_mark_running"? Hmm — or SHARE the activity instances? The
     mark-running logic is identical (status RUNNING, version chain).
     Sharing one registered "mark_running" across both workflows = less
     code, one name. DO: shared `JobActivities` (mark_running) +
     workflow-specific classes. Refactor activities.py: extract generic
     mark_running into shared class? 0L tests reference
     FoundationEchoActivities.mark_running... refactor churn vs dup:
     KEEP FoundationEcho* untouched (frozen), OCR gets its own
     `ocr_mark_running`? Ugly. Alternative: instantiate ONE
     FoundationEchoActivities and pass its bound mark_running to BOTH
     workflows' activity lists + OCR-specific class for the rest.
     Temporal allows registering the same activity fn once and calling
     from multiple workflows (resolve by name). CLEANEST: shared
     instance method registered once; both workflows'
     execute_activity reference the same bound method. 0L tests keep
     passing (same object). DO THAT.)
  2. `get_ocr_input` → AppApiClient.get_ocr_input (new method) →
     OcrJobInputV1.
  3. `download_receipt` → AppApi file read-url + GET bytes + sha256
     verify vs expectedSha256 (mismatch → raise → FAILED path).
  4. `resolve_route` → Foundry effective-route.
  5. `reserve_quota` → Foundry reserve (idempotency `{jobId}:ocr:reserve`).
     Conflict → raise QuotaBlockedError (activity raises custom error;
     workflow catches? Temporal workflows catch exceptions fine) — hmm,
     cleaner: reserve_quota RETURNS {"blocked": True} instead of raising
     (keeps workflow linear, no exception-driven control flow through
     Temporal's serialization). DO: return dataclass-ish dict.
  6. `mark_call_started` → Foundry.
  7. `run_fake_extraction` (pure CPU, still an activity for retry
     isolation): FakeOcrProvider.extract(bytes, content_type) → dict =
     OcrExtractionResultV1 JSON (canned merchant "Fake OCR Merchant",
     amount "12.34", currency USD, incurredOn fixed "2026-09-09",
     confidence 1.0, NO optionals — maximally exercises exclude_none).
     On exception: workflow releases reservation then fails job.
  8. `record_accepted` → Foundry outcome accepted (attempt 1).
  9. `submit_extraction` → AppApi submit_result SUCCEEDED +
     resultSchemaVersion ocr-extraction-v1.
  Failure mapping (workflow-level, linear): blocked → submit FAILED
  `{error: "QUOTA_BLOCKED..."}`... wait — FAILED result payload must
  still satisfy... submitResult only parses OcrExtractionResultV1 when
  SUCCEEDED. FAILED payload: `{ error: str }` record — schema-valid
  (result: record). resultSchemaVersion still "ocr-extraction-v1"
  (matches job's allowed version — version check passes, apply skipped
  on FAILED). 
  Download/sha/route failures → release reservation (if held) +
  recordStatusUpdate FAILED (message prefix `OCR_FAILED:`). Reserve
  never happened → just status FAILED.
  4xx from App API submit → fallback recordStatusUpdate FAILED (0L
  pattern? — actually 0L worker has no such fallback... keep simple:
  let activity raise → Temporal retries → eventually workflow fails →
  job stays RUNNING (stuck!). Hmm. Poison-message story: Temporal
  activity retries default = infinite! MUST set retry policies:
  `RetryPolicy(maximum_attempts=...)` on activities (e.g., 5 for HTTP,
  3 for fake extraction). And a workflow-level catch: on terminal
  activity failure after retries, workflow's final act = status-update
  FAILED (best-effort, swallow errors) then return (workflow completes;
  job FAILED). This closes the stuck-RUNNING hole for 0C. 0L's echo
  workflow lacks this — note as known 0L gap, NOT retrofitting here
  (frozen foundation; echo jobs are test-only).
- `providers/fake_ocr.py`: pure function, unit-tested directly.
- `workflows.py`: `OcrReceiptWorkflow` (name const mirrored). Input:
  JobReferenceV1 (unchanged minimal!). Version threading per 0L
  (DISPATCHED=2 start).
- `run_worker.py`: register workflow + activities; foundry client from
  env; share mark_running instance.
- `constants.py`: OCR_RECEIPT_WORKFLOW_TYPE + OCR schema version const;
  TS mirror already planned in task-queues.ts.

## Testing

1. **Contracts** `phase-0c-contracts.test.ts`: extraction schema
   (amount/currency/date reuse, confidence bounds, strict reject),
   mode keys, input schema, effective-route shape, source enum.
2. **App API unit** `test/ocr.test.ts`: tenant create (201 + scope +
   idempotency), disabled mode 403, bound file 409, non-READY 409,
   ai-worker ocr-input 200, wrong principal 403, tenant on internal
   401, list jobs.
3. **Foundry unit** `test/effective-route.test.ts`: resolves seeded
   shape (mocked domain), guards (ai-worker+routes:read ok; wrong
   scope/principal 403).
4. **App integration** `test/integration/app-domain-0c-ocr.test.ts`
   (PHASE_0C_INTEGRATION=1): entitlement gate (accurate disabled →
   forbidden; fast ok), double-job-after-success → 409, apply creates
   expense (source ocr, ready, fields, file bound, job backfilled),
   version-mismatch → precondition, FAILED result stores w/o expense,
   replay idempotent (no second expense).
5. **Foundry integration** (same flag): effective-route resolves seeded
   fake rows; unknown mode → 404; full reserve→started→accepted→CONSUMED
   for RECEIPT_OCR with fake model id (real counters move).
6. **Python**: `test_ocr_activities.py` (respx, ActivityEnvironment per
   0L), `test_ocr_workflow.py` (time-skipping, real activities +
   respx-mocked App API + Foundry — mirrors 0L's workflow test),
   `test_fake_ocr.py` (pure).
7. **E2E** `test/integration/app-domain-0c-ocr-loop.test.ts`
   (PHASE_0C_OCR_LOOP=1): THE §22 gate. Real App API listen + real
   Foundry listen (fake service verifiers) + real worker subprocess
   (both service tokens) + real Temporal + real Postgres + tmpdir
   storage. Flow: seed tenant → entitlements (lazy trial) → create+
   confirm file (domain) → create OCR job (domain) → dispatch (real
   starter) → poll file.expense_id → assert expense (ocr/ready/canned
   fields) + job SUCCEEDED + Foundry reservation CONSUMED (query
   foundry.ai_quota_reservations by idempotency key). Exhaustion
   sub-case: RECEIPT_OCR policy max_jobs=0 via quotas domain →
   job FAILED + QUOTA_BLOCKED message + no expense. Cleanup both DBs.
8. **Verify** `scripts/verify-phase-0c.mjs`: cascades verify:phase-0d
   (with all its flags), adds contracts/app-api/foundry tests, 0C
   integration (both services), python pytest, e2e loop (flag-gated,
   required for zero-skip), drift, docker builds (app-api, foundry,
   ai-worker), readiness probes.

## Non-goals (revisit only with a real caller)

- Admission grants + reservation-route linkage (Foundry hardening;
  pre-release track).
- Upfront quota-status proxy (needs token acquisition; frontend phase).
- Real vision-LLM adapter (needs credentials; next AI phase).
- Dedup (3B), category suggest (3C), re-OCR, attach-then-extract.
- 0L echo-workflow stuck-RUNNING hardening (test-only path; noted).
