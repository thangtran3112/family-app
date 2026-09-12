# SDD ledger — plan: docs/superpowers/plans/2026-09-11-phase-3b-deduplication.md

## Preflight Scan

| Tasks | Shared interface/file | Finding | Ruling |
|---|---|---|---|
| 1 -> 2 | contracts, migration, App database types | Task 2 consumes schemas/tables from Task 1. No conflict. | Freeze contract names and migration tables first. |
| 1 -> 3 | `DeduplicationEvidenceV1` | Task 3 serializes Task 1 evidence contract. No conflict. | Worker sends only evidence and opaque job reference. |
| 2 -> 3 | `/internal/v1/jobs/:jobId/deduplication` | Task 3 calls Task 2 route. No conflict. | Route requires existing worker M2M guard. |
| 2 -> 4 | deduplication domain | Task 4 extends matching domain with user resolution. No conflict. | Keep one domain transaction boundary. |
| 4 -> 5 | public duplicate-match routes/contracts | Task 5 consumes Task 4 list/resolve contract. No conflict. | Office only; Foundry never receives customer duplicate data. |
| 5 -> 6 | Office UI and API | Task 6 runs frontend verification after UI. No conflict. | Production deployment remains separate approval gate. |

| Task | Self-consistency | Ruling |
|---|---|---|
| 1 | Tables, types, contracts, tests align. | Proceed. |
| 2 | Evidence callback uses job binding and scope-safe matching. | Proceed. |
| 3 | Worker submits OCR result first, then posts evidence with returned succeeded-job version. | Proceed. |
| 4 | Resolution actions are transactional, versioned, and non-destructive. | Proceed. |
| 5 | Office-only review consumes authorized App API data. | Proceed. |
| 6 | Verification covers all artifacts and deferred similarity scope. | Proceed. |

## Decisions

- Ruling: Exact and fuzzy candidates remain pending review; no automatic merge/discard because same merchant/date/amount can be legitimate separate purchases. Cost if wrong: users must review obvious duplicates manually.
- Ruling: Deterministic first slice excludes pHash, embeddings, semantic similarity, mailbox scanning, and paid provider calls. Cost if wrong: near-duplicate receipts wait for later feature work.
- Ruling: Existing `expense-service` legacy SQLAlchemy models remain untouched; TypeScript App API owns new deduplication schema and mutations. Cost if wrong: legacy and current schemas do not share deduplication behavior.
- Task 1: fix round 1/5 (schema scope/idempotency/state findings addressed; commit `866f087`)
- Task 1: fix round 2/5 (tenant/scope trigger and contract parity findings addressed; commit `2e63a7b`)
- Task 1: fix round 3/5 (parent scope mutation and trim parity findings addressed; commit `c90e1fb`)
- Task 1: complete (commits `62ce952..c90e1fb`, review clean)
- Ruling: Existing OCR materializes candidate expense only inside normal result submission; reorder worker flow to submit extraction first, then call dedup evidence with returned job version. Cost if wrong: candidate reaches ready state before dedup review, but no duplicate is auto-resolved and callback remains retryable.
- Task 2: fix round 1/5 (post-result binding, SHA-only evidence, canonicalization, currency scope, SQL predicates addressed; commit `b28d711`)
- Task 2: fix round 2/5 (bounded idempotency, archived target exclusion, currency scales addressed; commit `6762b49`)
- Task 2: fix round 3/5 (contract precision aligned; commit `2702d7b`)
- Task 2: fix round 4/5 (currency-aware safe bounds addressed; commit `c7cd683`)
- Task 2: complete (commits `48e7f40..c7cd683`, review clean)
- Task 3: fix round 1/5 (optional OCR order evidence added and forwarded; commit `59baaf6`)
- Task 3: complete (commits `1a51293..59baaf6`, review clean)
- Task 4: fix round 1/5 (sorted expense locks and domain mutation coverage; commit `7a1ae3e`)
- Task 4: fix round 2/5 (disposable PostgreSQL rollback/Business-scope integration coverage; commit `d8bd2a1`)
- Task 4: complete (commits `387a60d..d8bd2a1`, review clean)
- Task 4: minor (deferred): generated OpenAPI/client output has route-order churn; `contracts:check` passes and no unrelated source files changed.
- Task 5: fix round 1/5 (badge invalidation, auth states, pagination, rendered tests; commit `a0cc249`)
- Task 5: fix round 2/5 (auth normalization, refresh/race handling, Node-compatible jsdom, rendered errors; commit `310a507`)
- Task 5: fix round 3/5 (multi-item success announcement; commit `95aaf6a`)
- Task 5: complete (commits `c47afc2..95aaf6a`, review clean)
- Task 6: fix round 1/5 (verification coverage and push status made explicit; commit `42849df`)
- Task 6: complete (commits `bdcb466..42849df`, review clean; real PostgreSQL coverage remains limited to merge rollback/Business scope, with other idempotency/action cases covered by unit/domain tests)
- Final review: Critical — dedup scope triggers use unlocked parent reads. Important — post-result dedup failure attempts illegal `SUCCEEDED -> FAILED`; Office amount display assumes two decimals. Minor — deleted/non-ready source files may match.
- Final fix wave: critical scope locking, durable post-result callback retry, currency-scale UI, and existing-file READY filtering addressed in `6fccffe`; report counts corrected in `a4af106`; scoped re-review cleared critical/important findings.
- Final review parked: candidate source file itself can still be `PENDING`/`FAILED` when evidence runs. Ruling: existing candidate expense is already materialized and active; this is a non-blocking source-state hardening follow-up, not an authorization or data-loss path. Cost if wrong: an invalid source file state could produce a review candidate before normal file readiness enforcement.
- Final fix verification: scope trigger parent locks, durable post-result worker retry, currency-scale Office rendering, and READY existing-file filtering verified by fresh App API/worker/Office tests, disposable PostgreSQL integration, contracts, lint, typecheck, build, and diff checks.
- Phase 3B implementation: complete (commits `62ce952..a4af106`, final re-review clean with 1 parked non-blocking source-state finding; production deployment not run).
- Task 6: complete. Full root TypeScript, generated-contract, worker, Office,
  focused callback, and disposable PostgreSQL verification passed. Counts:
  408 root TypeScript tests, 54 worker tests, 43 Office tests, 14 focused
  worker callback tests, and 1 PostgreSQL integration test. One pre-existing
  Foundry database test skipped. Office build required local placeholder
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; no production credential used.
- Task 6: generated artifacts clean, `git diff --check` clean, disposable
  PostgreSQL database removed after test. pHash/imagehash, embeddings,
  semantic similarity, mailbox scanning, and paid provider work remain
  deferred. No production mutation/deploy/external action performed.
- Task 6: detailed evidence in
  `.superpowers/sdd/2026-09-11-phase-3b-deduplication/task-6-report.md`.
