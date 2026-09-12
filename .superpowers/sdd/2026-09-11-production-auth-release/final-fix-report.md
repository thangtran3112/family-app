# Final Production Auth Fix Wave

## Files changed

- `expense-tax-management/services/app-api/src/app.ts`
- `expense-tax-management/services/app-api/src/routes/clerk-webhooks.ts`
- `expense-tax-management/services/app-api/test/clerk-webhooks.test.ts`
- `expense-tax-management/scripts/provision-production-clerk.mjs`
- `expense-tax-management/scripts/provision-production-clerk.test.mjs`

Unrelated worktree changes, controller docs, ledger, and prior reports were preserved.

## Red/green evidence

- RED: new webhook boundary/chunking tests initially failed because no bounded body constant or limiter existed.
- RED: new Foundry membership, NULL-safe SQL, and environment allowlist assertions initially failed against existing implementation.
- GREEN: all new regression tests pass after minimal fixes.

## Changes

- Clerk webhook raw-body buffering now rejects payloads over 1 MiB before signature verification, JSON parsing, or handler execution. Content-length and chunked bodies are bounded. Accepted bytes remain unchanged.
- `executePsql` now passes database variables plus `PATH`, `HOME`, locale, and temp-directory variables only. Ambient Clerk/API/application secrets are excluded.
- `provisionFoundryOperator` now requires and verifies Clerk memberships at its exported boundary. Main path and direct tests pass verified memberships.
- Bootstrap conflict guards use PostgreSQL `IS DISTINCT FROM` for expected identity, profile, role, and status values.

## Commands/results

- `pnpm test`: PASS. Contracts 54/54, app-api 240/240, Foundry 120 passed, 1 existing skipped.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm exec vitest run scripts/provision-production-clerk.test.mjs`: PASS, 46/46.
- `git diff --check`: PASS.

## Self-review

- No production deployment, external API call, or production mutation performed.
- No secrets printed or added.
- No generated files, controller docs, ledger, prior reports, or unrelated dirty files changed.
- Limit equals Fastify's normal 1 MiB body limit, preserving exact-boundary acceptance and raw-byte signature verification.

## Commit

- Pending at report creation; commit includes only this report and five implementation/test files.

## Concerns

- Foundry database suite retains one pre-existing skipped test; no new skips introduced.
