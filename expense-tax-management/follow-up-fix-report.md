# Authorized Follow-up Fix Wave

Date: 2026-09-10

## Scope

Implemented residual findings from `task-10-re-review-1.md`:

- App API production Clerk mapping was not wired into the runtime `buildApp` path.
- Clerk tenant tokens could authenticate without a signed organization claim.
- Foundry platform authorization trusted provider-supplied `platform_role` and
  `roles` claims instead of an application-owned operator mapping.

Requested source artifacts `final-review.md`, `final-fix-report.md`,
`task-10-re-review-1.md`, and a ledger file were not present in this workspace.
Only `.superpowers/sdd/2026-09-10-clerk-auth-integration/task-4-report.md`
was available. This report records evidence from current source and tests.

## Changes

### App API

- `services/app-api/src/server.ts` now creates one runtime Kysely database,
  passes `createDatabaseClerkIdentityMappingDomain(database)` into `buildApp`,
  and destroys the database during shutdown/startup failure.
- `services/app-api/src/app.ts` also defaults every `buildApp` caller to the
  database-backed Clerk mapping domain, preventing null mapping in alternate
  runtime entry paths.
- Clerk verifier configuration requires a non-null signed tenant organization
  ID (`org_id` or signed Clerk `o.id`). Legacy non-Clerk verifier configuration
  remains unchanged.
- Existing authenticated tenant guard behavior resolves signed Clerk user/org
  IDs to application UUIDs and rejects route `tenantId` mismatches.

### Foundry

- Added migration `005_platform_operator_identities` with application-owned
  `clerk_user_id`, constrained operator role, active/disabled status, and
  timestamps.
- Added `PlatformOperatorDomain`, backed by PostgreSQL, and wired it through
  `buildApp` and the auth plugin.
- `platformGuard` now requires a platform token and a database mapping for the
  signed subject and requested role. Provider `platform_role`, `roles`, tenant
  `org_role`, and `o.rol` claims cannot authorize operator routes.
- Updated route-test fixtures to model mapped application operators rather
  than provider claims.

## TDD Evidence

- RED: App auth suite failed on new missing-organization assertion before the
  verifier check existed; default mapping assertion failed while the runtime
  path returned `null`.
- RED: Foundry auth/route suite failed after provider-claim authorization was
  replaced, before test mapping fixtures and plugin decoration were completed.
- GREEN: focused App API suite: `24` test files, `222` tests passed.
- GREEN: focused Foundry auth/catalog/quota/operations suite: `8` test files,
  `102` tests passed.

## Verification

- App API typecheck: passed.
- Foundry typecheck: passed.
- App API lint: passed.
- Foundry lint: passed.
- App API build: passed.
- Foundry build: passed.
- Repository-wide `pnpm test`: contracts `54` passed, App API `222` passed,
  Foundry `102` passed.
- Repository-wide `pnpm lint`: passed for contracts, App API, and Foundry.
- Repository-wide `pnpm typecheck`: passed for contracts, App API, and Foundry.
- Repository-wide `pnpm build`: passed for contracts, App API, and Foundry.
- `git diff --check`: passed.
- No Clerk secrets, bearer tokens, or browser credentials added.
- Unrelated mockup and user-authored worktree changes were not staged.
