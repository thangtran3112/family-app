# Phase 3B Final Fix Report

Date: 2026-09-12
Repository: `/Users/toby.tran/personal/family-app/expense-tax-management`
Scope: final review fix wave only. No production mutation, deployment, subagents, or external action.

## Findings Fixed

1. `015_expense_deduplication.ts` now locks every referenced expense, expense-file, and inbound-email parent row with `FOR UPDATE` during scope-trigger validation. This serializes parent scope reads against concurrent dedup writes and preserves existing scope guards.
2. Post-result worker deduplication now runs outside OCR failure mutation handling. Temporal retries remain durable for network/5xx and transient 408/429 responses. Authorization, validation, not-found, conflict, and other non-retryable 4xx responses surface as non-retryable activity failures. No callback error attempts `SUCCEEDED -> FAILED`; successful OCR result remains successful.
3. Office duplicate amount rendering now uses shared `DEDUPLICATION_CURRENCY_MINOR_UNIT_SCALES`, covering normal two-decimal currencies, zero-scale JPY, and three-scale KWD.
4. Exact SHA candidate SQL now requires source file status `READY`; `DELETED`, `PENDING`, and `FAILED` files cannot produce duplicate candidates. Pure candidate selection also rejects non-READY rows.

## Regression Coverage

- Migration test asserts all parent scope lookups use row locks.
- App API tests assert deleted SHA sources are excluded and query requires `READY`.
- Worker workflow tests assert retry exhaustion and non-retryable callback failures do not issue a failed status mutation after success.
- Office tests assert USD, JPY, and KWD rendering through the page formatter and shared scale map.

## Verification

| Area | Result |
|---|---|
| Root TypeScript tests | `pnpm test`: 480 passed; 1 pre-existing Foundry database test skipped |
| App API tests | 29 files, 280 passed |
| Contracts tests | 12 files, 61 passed |
| Worker tests | 55 passed |
| Worker callback tests | 15 passed |
| Office tests | 6 files, 46 passed |
| Disposable PostgreSQL | `PHASE_3B_INTEGRATION=1 ...app-domain-3b-deduplication.test.ts`: 1 passed |
| Contracts | `pnpm contracts:generate` and `pnpm contracts:check` passed; no generated diff |
| Lint/typecheck/build | Root, App API, and Office passed; Office build used local placeholder Clerk key |
| Worker quality | Ruff check passed; 22 files formatted |
| Diff checks | `git diff --check` passed |

## Constraints and Concerns

- Pending-review behavior, no hard deletion, exact scope/auth/idempotency/version semantics remain unchanged.
- pHash/imagehash, embeddings, semantic similarity, mailbox scanning, and paid provider work remain deferred.
- Office browser smoke was not run; existing component and page tests plus authenticated-gate build verification cover this wave.
- Generated contract tooling emitted existing datamodel-code-generator `FutureWarning` messages only.
- No production database, deployment pipeline, customer data, or external service was contacted.
