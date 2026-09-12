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

## Migration Ordering

- `013_clerk_identity_mappings.ts` and `014_clerk_webhook_events.ts` are existing auth migrations.
- `015_expense_deduplication.ts` is final migration filename; auth migrations and legacy Python models remain unchanged.

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

## Review Round 2 Fixes

- Added migration-owned `app.validate_expense_dedup_scope()` trigger function and INSERT/UPDATE triggers on all three dedup tables. It compares tenant, Personal profile, and Business scope for every referenced expense/file/inbound email.
- The same trigger validates `resolved_by` against an active `app.tenant_memberships` row for the match tenant. This is database-level actor attribution; App domain authorization remains required above it.
- Added terminal-state immutability guard using `OLD IS DISTINCT FROM NEW`; pending rows may transition, terminal rows cannot change.
- Added trimmed nonempty normalized merchant check and corresponding regression assertion.
- Added `idempotencyKey` to strict duplicate-match and resolution-response contracts.
- Evidence match-type combinations remain intentionally deferred to later matching-domain implementation and are recorded by existing match-type/evidence contracts.
- Added trigger, membership, merchant, terminal-state, response-idempotency, and down-cleanup regression assertions.

## Review Round 2 Verification

- Focused contracts/schema suite: 2 files, 8 tests passed.
- App API test suite: 27 files, 259 tests passed.
- Contracts and App API lint, typecheck, build, and generated contract checks passed.
- Disposable PostgreSQL migration test: migrations 001-015 applied successfully after creating required disposable `app` schema; direct 015 down completed; dedup tables, migration-owned indexes, and trigger functions were absent afterward.
- `git diff --check` passed.

## Remaining Concern

- Disposable validation required explicit creation of `app` schema because project initialization normally creates it outside migration files. No production database was contacted or mutated.

## Review Round 3 Fixes

- Added migration-owned `app.prevent_expense_dedup_parent_scope_update()` and BEFORE UPDATE scope guards on expenses, expense files, and inbound emails. Referenced parent scope changes now fail while provenance, fingerprints, or duplicate matches depend on the row.
- Changed duplicate evidence `normalizedMerchant` to trim before minimum-length validation, rejecting whitespace-only values consistently with SQL.
- Canonicalized database callback and resolution idempotency checks with exact `key = trim(key)` constraints while preserving length and null-state rules.
- Added parent-trigger/function SQL-shape and whitespace evidence regression assertions.

## Review Round 3 Verification

- Focused contracts/schema suite: 2 files, 8 tests passed.
- App API test suite: 27 files, 259 tests passed.
- Contracts and App API lint, typecheck, build, and generated contract checks passed.
- Disposable PostgreSQL migration test: migrations 001-015 applied successfully; direct 015 down completed; dedup tables and parent guard function were absent afterward.
- `git diff --check` passed.

## Final Concern

- No production database or external service was contacted or mutated. Generated checks retain existing Python formatter deprecation warnings.
