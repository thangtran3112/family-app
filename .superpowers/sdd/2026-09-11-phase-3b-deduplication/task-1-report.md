# Phase 3B Task 1 Report

## Result

Implemented Task 1 contracts and deduplication schema.

## Changes

- Added `015_expense_deduplication.ts` with provenance, versioned fingerprint, and duplicate-match tables.
- Added tenant/scope foreign keys, exact Personal/Business XOR checks, source-reference checks, status and match-type checks, confidence bounds, lookup indexes, and idempotency/duplicate uniqueness constraints.
- Added Kysely database table types and registered all three tables in `AppDatabase`.
- Added strict Zod contracts for duplicate matches, lists, resolutions, provenance, comparison evidence, and worker `DeduplicationEvidenceV1`.
- Exported deduplication contracts from package index.
- Added focused contract and migration-shape tests.
- Preserved legacy Python models, auth code, existing Clerk migrations, and unrelated worktree files.

## TDD Evidence

- Red: focused suite failed because required migration and contract exports were absent.
- Green: focused suite passed after implementation.

## Verification

- `pnpm exec vitest run packages/contracts/test/duplicate-matches.test.ts services/app-api/test/database-deduplication.test.ts`: 2 files, 7 tests passed.
- App API test suite: 27 files, 258 tests passed.
- Contracts typecheck, lint, build: passed.
- App API typecheck, lint, build: passed.
- `pnpm contracts:check`: passed.
- `git diff --check`: passed.

## Concerns

- Existing repository already contains `013_clerk_identity_mappings.ts` and `014_clerk_webhook_events.ts`; brief-required filename `013_expense_deduplication.ts` was added without changing those auth migrations. Fresh migration ordering therefore contains two `013_*` files; follow-up should renumber this dedup migration or reconcile migration numbering before applying to a shared database.
- No live/disposable PostgreSQL migration execution was run; verification used migration-source assertions and TypeScript compilation. No production database was contacted or mutated.

## Migration Numbering Fix

- Renamed `013_expense_deduplication.ts` to `015_expense_deduplication.ts` so Kysely migration identities and ordering are unique after existing Clerk migrations 013 and 014.
- Updated focused migration test path; migration SQL unchanged.
- Re-ran focused schema/contract tests, App API tests, generated checks, typecheck, build, lint, and diff checks after rename.

## Review Fixes

- Added tenant-scoped composite unique indexes and composite foreign keys for expenses, expense files, inbound emails, existing matches, and candidate matches.
- Bound resolution idempotency keys to resolved match state, added non-null partial uniqueness, and restricted candidate/existing/type uniqueness to pending matches.
- Enforced `manual_upload` as file-only and `forwarded_email` as inbound-email-required with optional file provenance in SQL and Zod.
- Added strict duplicate-match resolution metadata validation and provenance source-reference validation.
- Updated down migration to remove migration-owned reference indexes after dependent tables are dropped, following existing Kysely migration conventions.
- Added regression assertions for SQL shape, state constraints, source consistency, and down migration cleanup.

## Review Fix Verification

- Focused contracts/schema suite: 2 files, 8 tests passed.
- App API test suite: 27 files, 259 tests passed.
- Contracts and App API lint, typecheck, build, and generated contract checks passed.
- `git diff --check` passed.

## Remaining Concern

- No disposable PostgreSQL migration execution was run; verification used migration-source assertions and TypeScript compilation. No production database was contacted or mutated.
