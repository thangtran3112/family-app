# Phase 3B Task 6 Verification Report

Date: 2026-09-12
Repository: `/Users/toby.tran/personal/family-app`
Project: `expense-tax-management`
Scope: local verification only; no production mutation, deployment, or external action.

## Requirements

Reviewed:

- `.superpowers/sdd/2026-09-11-phase-3b-deduplication/task-6-brief.md`
- `docs/superpowers/specs/2026-09-11-phase-3b-deduplication-design.md`
- `docs/superpowers/plans/2026-09-11-phase-3b-deduplication.md`
- `.superpowers/sdd/2026-09-11-phase-3b-deduplication/progress.md`

Task requires full local TypeScript, contracts, worker, Office, integration,
and diff verification; evidence updates only in Phase 3B plan/ledger docs; no
paid similarity or mailbox work.

## Verification Results

All commands below exited zero unless noted in Caveats.

| Area | Command | Result |
|---|---|---|
| Root TypeScript tests | `pnpm test` | 408 passed; 1 pre-existing Foundry database test skipped |
| Root lint | `pnpm lint` | Passed |
| Root typecheck | `pnpm typecheck` | Passed |
| Root build | `pnpm build` | Passed |
| Contract generation | `pnpm contracts:generate` | Passed; generated files unchanged |
| Contract drift | `pnpm contracts:check` | Passed; generated files unchanged |
| Worker tests | `uv run pytest` from `services/ai-worker` | 54 passed |
| Worker Ruff lint | `uv run ruff check src tests` | Passed |
| Worker Ruff format | `uv run ruff format --check src tests` | 22 files already formatted |
| Worker callback tests | `uv run pytest tests/test_service_clients.py tests/test_ocr_activities.py tests/test_ocr_workflow.py` | 14 passed |
| Office tests | `pnpm --filter @expense-tax/office-web test` | 43 passed across 6 files |
| Office lint | `pnpm --filter @expense-tax/office-web lint` | Passed |
| Office typecheck | `pnpm --filter @expense-tax/office-web typecheck` | Passed |
| Office build | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_phase3b_local_placeholder pnpm --filter @expense-tax/office-web build` | Passed; 14 static routes generated |
| PostgreSQL integration | `PHASE_3B_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-3b-deduplication.test.ts` | 1 passed |
| Diff whitespace | `git diff --check` | Passed |

## Integration Evidence

Disposable PostgreSQL integration used local Compose PostgreSQL only. Test
created a random disposable database, ran migrations `001` through
`015_expense_deduplication`, seeded Business-scope data, and verified:

- Business duplicate list returns only authorized scope data.
- Foreign Business scope cannot read or resolve the match.
- Forced resolution failure rolls back expense, file, provenance, match, and audit mutations.
- Merge archives candidate expense without hard deletion.
- Candidate file and provenance transfer to existing expense.
- Successful merge increments match version and creates one audit event.
- Test database is dropped with `WITH (FORCE)` during cleanup.

Post-test query found no `expense_tax_dedup_*` databases remaining in local
PostgreSQL.

## Generated Artifacts

`pnpm contracts:generate` followed by `pnpm contracts:check` produced no
working-tree changes. No generated artifact was manually modified.

## Scope Audit

No production database, deployment pipeline, public endpoint, mailbox, paid
provider, or external service was contacted. No source files were edited for
Task 6. No pHash/imagehash, embedding, pgvector similarity, semantic
similarity, or mailbox scanning implementation was added or executed. Existing
legacy/planning references to embeddings and mailbox work remain unrelated and
unchanged.

## Caveats

- First Office build invocation without environment setup failed because the
  existing Clerk guard requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Rerun with
  a local non-production placeholder passed; no real Clerk key was used.
- An initial integration invocation omitted `PHASE_3B_INTEGRATION=1` and was
  correctly skipped by the test gate. Required flagged invocation passed.
- An auxiliary focused worker command was first run from repository root with
  service-relative paths and collected zero tests. It was rerun from
  `services/ai-worker` and passed all 14 callback tests.
- Contract generation emitted dependency `FutureWarning` messages only; the
  commands exited zero and generated-artifact check passed.
- Browser smoke at 1024/1440 was not run because brief says if available and no
  browser smoke harness was required for this verification.

## Deferred Work

Per approved spec and ledger, pHash/perceptual hashing, embeddings, semantic
similarity, pgvector search, mailbox scanning, and paid provider calls remain
outside Phase 3B and require separate approved work, cost/quota policy, and
verification.

## Evidence Files

- `docs/superpowers/plans/2026-09-11-phase-3b-deduplication.md`
- `.superpowers/sdd/2026-09-11-phase-3b-deduplication/progress.md`
- `.superpowers/sdd/2026-09-11-phase-3b-deduplication/task-6-report.md`

## Review Round 1 Correction Evidence

Focused verification rerun after review:

- `services/app-api/test/deduplication.test.ts` and
  `services/app-api/test/duplicate-resolution.test.ts`: 19 tests passed with
  the App API test environment variables configured.
- `services/ai-worker/tests/test_service_clients.py`,
  `services/ai-worker/tests/test_ocr_activities.py`, and
  `services/ai-worker/tests/test_ocr_workflow.py`: 14 tests passed.
- `test/integration/app-domain-3b-deduplication.test.ts` with
  `PHASE_3B_INTEGRATION=1`: 1 real PostgreSQL test passed and disposable DB
  cleanup passed.

Exact requested coverage mapping:

| Requirement | Exact test evidence | Coverage type and status |
|---|---|---|
| Same-file-SHA matching | `services/app-api/test/deduplication.test.ts` - `matches exact and fuzzy candidates only inside exact tenant-derived scope` checks `file_sha256` candidate selection; `rejects incomplete fingerprint evidence while allowing exact file evidence` checks SHA-only evidence acceptance. | Unit/fake inputs only. Same-file-SHA **record idempotency was not run** against real PostgreSQL and remains incomplete. `test/integration/app-domain-3b-deduplication.test.ts` seeds a fingerprint match directly; it does not exercise SHA evidence recording. |
| Worker evidence replay/idempotency | `services/ai-worker/tests/test_service_clients.py` - `test_app_api_client_records_deduplication_evidence_with_auth_and_strict_body`; `services/ai-worker/tests/test_ocr_activities.py` - `test_ocr_record_deduplication_sends_only_job_bound_ocr_evidence`; `services/ai-worker/tests/test_ocr_workflow.py` - `test_ocr_workflow_runs_the_full_pipeline_to_succeeded` and `test_ocr_workflow_retries_dedup_and_fails_with_succeeded_result_version`. | Fake HTTP/Temporal coverage verifies opaque body, deterministic `{job_id}:ocr:dedup:v1` key, ordering, and retry failure path. It does **not** replay successful evidence through App API/PostgreSQL or assert no duplicate rows/provenance; end-to-end worker evidence replay/idempotency remains incomplete. |
| Fuzzy candidate remains pending | `services/app-api/test/deduplication.test.ts` - `matches exact and fuzzy candidates only inside exact tenant-derived scope` returns `matchType: "fuzzy_fields"` and checks amount/date evidence. | Unit/fake candidate calculation only. No test named or asserting fuzzy evidence insertion/status `pending` in real PostgreSQL; `test/integration/app-domain-3b-deduplication.test.ts` covers a manually seeded `fingerprint` match, not fuzzy recording. Fuzzy pending persistence remains incomplete. |
| Keep both | `services/app-api/test/duplicate-resolution.test.ts` - `resolves Business match with keep_both`; `applies keep_both without hard deleting candidate`. | Fake route/domain database coverage. Asserts `separate`, candidate remains `ready`, no transfer, and audit. No real PostgreSQL keep-both resolution was run; real-PostgreSQL coverage remains incomplete. |
| Discard new | `services/app-api/test/duplicate-resolution.test.ts` - `resolves Business match with discard_new`; `applies discard_new without hard deleting candidate`. | Fake route/domain database coverage. Asserts `dismissed`, candidate becomes `archived`, candidate row remains, no transfer, and audit. No real PostgreSQL discard-new resolution was run; real-PostgreSQL coverage remains incomplete. |

The real PostgreSQL test name is
`lists and resolves Business matches, denies foreign scope, and rolls back
partial merge` in `test/integration/app-domain-3b-deduplication.test.ts`. It
covers Business scope isolation, rollback, and merge only. It does not establish
the incomplete SHA record-idempotency, worker replay/idempotency, fuzzy-pending,
keep-both, or discard-new claims above.

## Push Status Correction

At report time, reviewed commits had **not yet been pushed**. Next action is
controller push after review. Production deployment remains a separate normal
CI/deploy workflow and public-verification approval gate. This task performed
no push or production action.

## Pre-existing Skipped Test

The one skipped root test is in
`services/foundry-service/test/database.test.ts`:
`allows one Clerk user to hold both operator roles and rejects duplicate role rows`.
It uses `it.skipIf(!migrationTestAllowed)`. Basis: `migrationTestAllowed` is
true only when `FOUNDRY_MIGRATION_TEST_DISPOSABLE=1` and
`FOUNDRY_MIGRATION_TEST_DATABASE_URL` has a localhost/127.0.0.1/`::1` host.
Root `pnpm test` did not set that explicit disposable Foundry migration gate,
so the test was intentionally skipped; it is not a Phase 3B failure.
