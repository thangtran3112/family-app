# SDD ledger — plan: docs/superpowers/plans/2026-09-11-production-auth-release.md

## Preflight Scan

| Tasks | Shared interface/file | Finding | Ruling |
|---|---|---|---|
| 1 -> 2 | `provision-production-clerk.mjs`, input parser | Task 2 extends Task 1 exports; no conflict. | Keep one script and one test file. |
| 2 -> 3 | Provisioning CLI/env contract | Task 3 consumes accepted Clerk IDs and existing UUIDs. | Runtime-only execution after user acceptance. |
| 2 -> 5 | Mapping + smoke identity contract | Smoke depends on exact IDs and role rows. | Verify mappings before smoke. |
| 4 -> 5 | Webhook endpoint/secret | Smoke requires deployed signing secret and reachable endpoint. | Webhook activation precedes replay test. |
| 5 -> Phase 1C | Authenticated boundaries | Gateway controls must not replace service authorization. | Keep Phase 1C separate. |

| Task | Self-consistency | Ruling |
|---|---|---|
| 1 | Validation exports and package command align. | Proceed. |
| 2 | Membership API, multi-role migration, psql env isolation, and dry-run align. | Proceed. |
| 3 | Runtime inputs match Task 1/2 names. | Proceed. |
| 4 | Existing route/handler/secret bundle are the integration points. | Proceed. |
| 5 | Smoke outputs are nonsecret and target all spec boundaries. | Proceed. |

## Decisions

- Ruling: thang receives both `operator` and `catalog_manager`; existing single-role primary key must become `(clerk_user_id, role)` because thang is user's personal platform account and needs all current platform permissions. Cost if wrong: one additive migration and role-row update.
- Ruling: production provisioning command defaults to dry-run and requires `PROVISION_PRODUCTION_CLERK_CONFIRM=Family-auth-release` for writes. Cost if wrong: operator must provide explicit confirmation even for intended provisioning.
- Task 1: complete (commit c8fda0f, review clean; 26 tests passed)
- Task 2: fix round 1/5 (migration coverage addressed; low direct-caller membership and migration rerun observations deferred; commits 7ea0559..bc5bef3)
- Task 2: fix round 2/5 (destructive migration-test setup guarded by explicit disposable marker; commit e214b8e)
- Task 2: complete (commits c8fda0f..e214b8e, review clean; provisioning 36 tests, Foundry 104 tests, migration 11 tests)
- Task 3: blocked — Clerk Dashboard still shows both production invitations pending; no production mapping writes or migration deploy performed.
- Invitation correction: revoked wrong `inv_...` application invites; fresh `orginv_...` Family invites now use `rurl=https://expense.tobytran.dev/accept-invitation`; same-browser smoke reaches password setup.
- Ruling: production App DB is empty, so confirmed `--bootstrap-empty` may explicitly create deterministic Family tenant/users/memberships/Personal profile rows before mapping; implicit runtime/webhook creation remains forbidden. Cost if wrong: bootstrap SQL owns initial App UUID selection.
- Clerk CLI/MCP: official CLI 3.3.0 installed, authenticated, linked to Family Expense Tax dev/prod instances; Clerk MCP installed for OpenCode and doctor reports reachable.
- Clerk accounts: thang signup passed end-to-end and joined Family; tramily created through Clerk CLI and added to Family with temporary discarded password.
- Task 2: bootstrap correction fix round 1/5 (explicit empty App bootstrap added; commit 0378fe6).
- Task 2: bootstrap correction fix round 2/5 (duplicate IDs rejected; real read-only dry-run preflight; commit 49e2294).
- Task 2: bootstrap correction complete (43 provisioning tests, 108 Foundry tests, review clean).
- Task 2: runtime fix (psql child environment preserves PATH; commit 5f38933, review clean; 44 tests).
- Task 3: complete — Clerk membership verification and read-only DB preflight passed; confirmed bootstrap created deterministic Family tenant, two App users, tenant/Personal memberships, and thang Foundry `operator` + `catalog_manager` rows; read-only verification matched exact IDs/roles.
- Task 4: fix round 1/5 (secure webhook secret file ingestion added; bare-prefix validation finding; commit 8589502).
- Task 4: fix round 2/5 (bare `whsec_`/empty/whitespace rejected; commit fe275ba; review clean).
- Task 4: runtime partial — Svix endpoint created for exact nine supported events; Secret Manager rotated to sole active version 4. Deployment loading version 4 is in CI.
- Ruling: Task 5 smoke assumptions referenced nonexistent auth-check routes and response metadata. Add narrow read-only guarded auth-check routes; use real frontend paths and expect tramily tenant token Foundry rejection as `401`. Cost if wrong: four small internal verification endpoints become production surface behind existing guards.
- Task 5: implementation complete with review fixes; focused/full verification passes; live production smoke pending and intentionally not executed in this task.
- Task 5 correction: registered guarded App/Foundry auth-check routes and corrected Capture/Office paths; behavioral tests, full tests, lint, and typecheck pass; live smoke remains pending.
