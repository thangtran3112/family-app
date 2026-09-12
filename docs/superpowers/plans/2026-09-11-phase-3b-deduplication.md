# Phase 3B Deterministic Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect deterministic duplicate expense candidates across uploaded files and forwarded email sources, preserve provenance, and let authorized Office users resolve candidates without hard deletion or automatic merging.

**Architecture:** App API owns schema, candidate matching, provenance, and all customer mutations. Python Temporal worker computes OCR evidence and calls a job-bound internal App API callback. Exact file hashes and normalized merchant/amount/date evidence form pending matches; perceptual/semantic similarity and mailbox scanning remain deferred.

**Tech Stack:** TypeScript Fastify/Kysely/Zod, PostgreSQL migrations, generated OpenAPI contracts, Python Temporal worker/httpx, Next.js Office Web, Vitest/Pytest.

**Spec:** `docs/superpowers/specs/2026-09-11-phase-3b-deduplication-design.md`

## Global Constraints

- App API remains sole writer for customer data.
- Python worker receives only opaque job references and extracted evidence; it does not receive database credentials and does not mutate App tables directly.
- Every candidate query and resolution is constrained by same tenant and same explicit Personal profile or Business scope.
- No expense is hard-deleted by deduplication.
- Exact duplicate candidates remain pending review; no automatic merge or discard.
- Do not add `imagehash`, embeddings, semantic similarity, mailbox scanning, or paid provider calls in this slice.
- Preserve existing OCR/M2M/service authorization and job version semantics.
- Preserve unrelated mockups and untracked files; stage exact Phase 3B paths only.

---

### Task 1: Contracts and Deduplication Schema

**Files:**
- Create: `expense-tax-management/services/app-api/src/database/migrations/013_expense_deduplication.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/packages/contracts/src/duplicate-matches.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`
- Create: `expense-tax-management/services/app-api/test/database-deduplication.test.ts`
- Create: `expense-tax-management/packages/contracts/test/duplicate-matches.test.ts`

**Interfaces:**
- Produces `DuplicateMatchSchema`, `DuplicateMatchListSchema`, `DuplicateResolutionRequestSchema`, `DuplicateResolutionResponseSchema`, `DeduplicationEvidenceV1Schema`, and related inferred types.
- Migration creates `app.expense_sources`, `app.expense_dedup_fingerprints`, and `app.expense_duplicate_matches` with tenant/scope constraints, status checks, indexes, and unique idempotency keys.

- [ ] **Step 1: Write failing schema/contract tests.**

Assert exact scope XOR constraints, match statuses `pending|merged|separate|dismissed`, match types `file_sha256|fingerprint|fuzzy_fields`, confidence bounds, strict evidence fields, and resolution actions `merge|keep_both|discard_new`.

- [ ] **Step 2: Run focused tests and verify red.**

Run: `pnpm exec vitest run packages/contracts/test/duplicate-matches.test.ts services/app-api/test/database-deduplication.test.ts`

Expected: FAIL because migration/contracts do not exist.

- [ ] **Step 3: Implement migration and database types.**

Create source/provenance rows with exactly one Personal/Business scope, duplicate match rows with version and resolution metadata, and fingerprint rows containing normalized merchant, amount minor units, currency, date, version, and hash. Add indexes for tenant/scope/candidate lookup and unique candidate/existing/match-type idempotency.

- [ ] **Step 4: Add strict Zod contracts.**

Expose generated OpenAPI-compatible schemas for list/detail/resolution and internal worker evidence. Evidence contains only job ID, source file ID, extraction fields, optional order number, expected job version, and idempotency key.

- [ ] **Step 5: Run migration/contract tests.**

Run: `pnpm exec vitest run packages/contracts/test/duplicate-matches.test.ts services/app-api/test/database-deduplication.test.ts`, App API typecheck, contracts build, and generated contract checks.

- [ ] **Step 6: Commit.**

```bash
git add services/app-api/src/database/migrations/013_expense_deduplication.ts services/app-api/src/database/types.ts packages/contracts/src/duplicate-matches.ts packages/contracts/src/index.ts packages/contracts/test/duplicate-matches.test.ts services/app-api/test/database-deduplication.test.ts
git commit -m "feat(dedup): add provenance and match schema"
```

### Task 2: App API Evidence and Candidate Matching

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/deduplication.ts`
- Create: `expense-tax-management/services/app-api/src/routes/deduplication.ts`
- Create: `expense-tax-management/services/app-api/test/deduplication.test.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/files.ts` only if source-link creation must be shared
- Modify: `expense-tax-management/services/app-api/src/routes/jobs.ts`

**Interfaces:**
- `createDeduplicationDomain(database)` returns `recordEvidence(input)` and `listMatches(input)`.
- `recordEvidence` consumes a job-bound `DeduplicationEvidenceV1` plus authenticated service principal and returns `{ decision: "no_match" | "review", matchIds: string[] }`.
- Internal route: `POST /internal/v1/jobs/:jobId/deduplication`, guarded by worker service subject and `jobs:write`.
- Public routes: scope-bound duplicate match list and resolution routes are added in Task 4.

- [ ] **Step 1: Write failing domain tests.**

Cover same file SHA in same scope, same fingerprint in same scope, fuzzy merchant/amount/date candidate, no match across profiles/businesses/tenants, repeated idempotency key, and worker evidence unable to select arbitrary scope or existing expense.

- [ ] **Step 2: Run tests and verify red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/deduplication.test.ts`

Expected: FAIL because domain/route are absent.

- [ ] **Step 3: Implement canonicalization.**

Normalize merchant with Unicode normalization, lowercase, trim, collapse whitespace, and remove punctuation. Convert decimal money to minor units and normalize date/currency. Build versioned fingerprint from these fields; reject evidence missing merchant, amount, currency, or date for fingerprint matching while still permitting exact file SHA matching.

- [ ] **Step 4: Implement scoped candidate queries.**

Resolve the job row and source file under the authenticated worker binding. Read scope from the job/file/database, never evidence. Query only same tenant and exact same Personal/Business scope. Insert provenance and pending match rows transactionally, with unique constraints making retries idempotent.

- [ ] **Step 5: Register internal route and schema.**

Use existing worker guard, `request.params.jobId`, strict evidence body, request ID, and service principal. Return only decision and match IDs. Do not return receipt bytes, secrets, or unrelated tenant data.

- [ ] **Step 6: Run App API verification.**

Run: focused dedup tests, full App API tests, lint, typecheck, and generated contracts check.

- [ ] **Step 7: Commit.**

```bash
git add services/app-api/src/domain/deduplication.ts services/app-api/src/routes/deduplication.ts services/app-api/src/routes/jobs.ts services/app-api/src/app.ts services/app-api/test/deduplication.test.ts services/app-api/src/domain/files.ts
git commit -m "feat(dedup): record scoped duplicate evidence"
```

### Task 3: Worker OCR Evidence Callback

**Files:**
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/ocr_activities.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/workflows.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_service_clients.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_ocr_activities.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_ocr_workflow.py`

**Interfaces:**
- `AppApiClient.record_deduplication_evidence(job_id, evidence)` posts to `/internal/v1/jobs/{job_id}/deduplication` using current M2M provider.
- Activity `ocr_record_deduplication` calls that client using only `job_reference`, `source_file_id`, and OCR extraction fields.
- `OcrReceiptWorkflow` submits the normal versioned OCR result after extraction, then invokes dedup evidence with the returned `SUCCEEDED` job version and deterministic idempotency key `{job_id}:ocr:dedup:v1`.

- [ ] **Step 1: Write failing worker tests.**

Assert callback URL/body/auth, evidence omits tenant/profile/business selectors, deterministic idempotency, retry behavior, and workflow ordering after successful result submission with returned job version.

- [ ] **Step 2: Run worker tests and verify red.**

Run: `uv --directory services/ai-worker run pytest tests/test_service_clients.py tests/test_ocr_activities.py tests/test_ocr_workflow.py`

Expected: FAIL because callback activity is absent.

- [ ] **Step 3: Implement client/activity/workflow call.**

Use existing authenticated `AppApiClient`, Pydantic request model, and Temporal retry policy. Treat duplicate evidence failure as OCR pipeline failure through existing typed failure path; do not mutate App data directly.

- [ ] **Step 4: Run worker verification.**

Run the focused worker tests, full worker tests, Python lint, and format checks.

- [ ] **Step 5: Commit.**

```bash
git add services/ai-worker/src/ai_worker/app_api_client.py services/ai-worker/src/ai_worker/ocr_activities.py services/ai-worker/src/ai_worker/workflows.py services/ai-worker/tests/test_service_clients.py services/ai-worker/tests/test_ocr_activities.py services/ai-worker/tests/test_ocr_workflow.py
git commit -m "feat(dedup): submit OCR duplicate evidence"
```

### Task 4: Authorized Duplicate Resolution API

**Files:**
- Modify: `expense-tax-management/services/app-api/src/domain/deduplication.ts`
- Create: `expense-tax-management/services/app-api/src/routes/duplicate-matches.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Create: `expense-tax-management/services/app-api/test/duplicate-resolution.test.ts`

**Interfaces:**
- `listMatches({ actorUserId, tenantId, scope, status?, cursor?, limit? })` returns scope-bound match list.
- `resolveMatch({ actorUserId, tenantId, scope, matchId, action, expectedMatchVersion, idempotencyKey, requestId })` returns prior or new resolution result.

- [ ] **Step 1: Write failing resolution tests.**

Cover merge, keep-both, discard-new, repeated idempotency, stale version conflict, non-pending conflict, cross-scope denial, candidate archive, provenance transfer, enrichment only for missing fields, and audit event creation.

- [ ] **Step 2: Run focused tests and verify red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/duplicate-resolution.test.ts`

Expected: FAIL because public routes and resolution operations are absent.

- [ ] **Step 3: Implement transactional resolution.**

Acquire match and candidate rows with `FOR UPDATE`, validate membership and exact scope, apply action without hard deletion, update provenance, archive candidate when required, mark match status, and write audit event in one transaction. Use existing idempotency helper and typed DomainErrors.

- [ ] **Step 4: Register scope-bound routes and generated contracts.**

Add Personal and Business route variants with tenant/profile/business params, list schemas, resolution body schema, and 409/403/404 responses. Regenerate OpenAPI/clients through existing contract scripts.

- [ ] **Step 5: Run App API and contract verification.**

Run focused/full App API tests, contracts check, lint, typecheck, build, and diff checks.

- [ ] **Step 6: Commit.**

```bash
git add services/app-api/src/domain/deduplication.ts services/app-api/src/routes/duplicate-matches.ts services/app-api/src/app.ts services/app-api/test/duplicate-resolution.test.ts packages/contracts/generated/openapi/app-api.openapi.json packages/contracts/generated/typescript/app-api.paths.ts
git commit -m "feat(dedup): add review resolution API"
```

### Task 5: Office Duplicate Review UI

**Files:**
- Create: `expense-tax-management/frontend/office-web/src/app/(office)/duplicates/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`
- Modify: `expense-tax-management/frontend/office-web/src/components/office-shell.tsx`
- Create: `expense-tax-management/frontend/office-web/src/lib/duplicates.test.ts`

**Interfaces:**
- Office calls generated App API duplicate-match list/resolution clients using current Clerk tenant token and active scope.
- UI exposes `merge`, `keep_both`, and `discard_new`; no Foundry/provider controls or raw receipt content beyond authorized expense details.

- [ ] **Step 1: Write failing UI/API helper tests.**

Cover pending list loading/error/empty states, action request payloads, 409 conflict refresh, unauthorized fail-closed state, and source badges.

- [ ] **Step 2: Implement API helpers and route.**

Use existing Office `getToken` injection and page-data loader patterns. Add explicit loading, error, empty, pending, resolved, and conflict states.

- [ ] **Step 3: Add navigation entry.**

Expose Duplicate Review only in Office Web, with a count/badge when pending matches exist. Capture gets only a handoff link; Foundry gets no customer duplicate route.

- [ ] **Step 4: Run frontend verification.**

Run Office tests, lint, typecheck, build, and browser smoke at 1024/1440 if available.

- [ ] **Step 5: Commit.**

```bash
git add frontend/office-web
git commit -m "feat(office): add duplicate review"
```

### Task 6: Full Phase 3B Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-09-11-phase-3b-deduplication.md` with evidence after implementation
- Modify: `.superpowers/sdd/2026-09-11-phase-3b-deduplication/progress.md`

- [x] **Step 1: Run full local verification.**

Run root TypeScript tests/lint/typecheck/build, contracts generation/check, full worker tests/lint/format, Office tests/lint/typecheck/build, and diff checks.

- [x] **Step 2: Verify integration boundaries.**

Run migration tests against disposable PostgreSQL, worker callback tests, scope isolation tests, and idempotency/replay tests. Do not run production mutation.

- [x] **Step 3: Record evidence and push.**

Record test counts, one pre-existing skip if present, and deferred pHash/semantic/mailbox work. Push reviewed commits. Production deployment requires normal CI/deploy workflow and public verification approval.

### Task 6 Evidence

- Root TypeScript: `pnpm test` passed 408 tests across gateway-policy, contracts,
  App API, and Foundry. One pre-existing Foundry database test skipped.
- Root lint/typecheck/build: `pnpm lint`, `pnpm typecheck`, and `pnpm build`
  passed.
- Contracts: `pnpm contracts:generate` and `pnpm contracts:check` passed. No
  generated artifact diff remained.
- Worker: full `uv run pytest` passed 54 tests; `uv run ruff check src tests`
  passed; `uv run ruff format --check src tests` reported 22 files formatted.
  Focused callback suite passed 14 tests.
- Office Web: 43 tests passed; lint and typecheck passed. Production build
  passed with local placeholder `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; initial
  no-key invocation failed at the expected required-config guard.
- PostgreSQL integration: `PHASE_3B_INTEGRATION=1 pnpm exec vitest run
  test/integration/app-domain-3b-deduplication.test.ts` passed. Disposable
  database was migrated through `015_expense_deduplication`, scope isolation,
  rollback, merge, provenance transfer, archive, audit, and cleanup checks
  passed. No disposable database remained.
- Diff checks: `git diff --check` passed; generated artifacts and unrelated
  source files remained unchanged before evidence edits.
- Scope guard: no production mutation, deployment, external action, paid
  provider call, pHash/imagehash, embeddings/semantic similarity, or mailbox
  scanning work was run or added. Those remain deferred.
- Full command output and caveats: `.superpowers/sdd/2026-09-11-phase-3b-deduplication/task-6-report.md`.
