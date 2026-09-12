# Phase 3B Task 1 Report

## Result

Implemented Task 1 contracts and deduplication schema.

## Changes

- Added `013_expense_deduplication.ts` with provenance, versioned fingerprint, and duplicate-match tables.
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
