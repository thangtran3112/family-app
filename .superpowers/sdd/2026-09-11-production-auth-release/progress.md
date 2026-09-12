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
- Ruling: Foundry Web is public but guarded Foundry Service API is loopback-only. Route only `expense-foundry.tobytran.dev/internal/v1/*` through existing Cloudflare Tunnel to `127.0.0.1:8200`, preserving generic Foundry Web routing and service token guards. Cost if wrong: guarded internal API becomes internet-reachable through Cloudflare, though origins remain private and every route retains auth.
- Task 5a: complete (commits `7ad4357..996ee30`, review clean)
- Ruling: Task 5 smoke cannot use `/health/ready` on Foundry hostname because path routing deliberately exposes only guarded `/internal/v1/*`; use Foundry Web `/` for public reachability, then guarded platform and M2M checks as Foundry Service readiness proof. Cost if wrong: no separate unauthenticated public Foundry Service readiness probe.
- Task 5b: complete (commit `172edbb`, review clean)
- Task 5 live smoke: 8/13 passed. Public pages, no-token denial, tramily Foundry denial, and webhook delivery/replay passed. Thang tenant/platform, tenant mismatch, and both M2M checks returned 401.
- Root cause: Clerk user JWT signature/issuer/audience verify successfully, but `expense-app` emits empty `display_name` for invited users without Clerk names and App verifier rejects it. Clerk M2M JWT emits the spec-documented singleton audience array, while both service verifiers incorrectly require scalar `aud`. Thang platform token also emits `roles: null` because required public metadata was never populated.
- Ruling: App tenant verifier falls back from missing/blank display name to already-required verified email; malformed non-string display names remain rejected. Cost if wrong: nameless users appear by email until profile data is supplied.
- Ruling: Service verifiers accept only scalar expected audience or exact singleton array containing expected audience; tenant/platform session tokens continue requiring scalar audiences and multi-audience service tokens remain rejected. Cost if wrong: expands accepted representation to Clerk's documented M2M shape without expanding destination boundary.
- Ruling: Populate approved test operator's Clerk profile and `foundry_roles` metadata rather than weakening platform role-marker validation. Cost if wrong: Clerk and Foundry role state require coordinated provisioning for future operators.
- Task 5c: fix round 1/5 (2 findings addressed, 0 open; commit `4e66f51`)
- Task 5c: complete (commits `d79b173..4e66f51`, review clean)
- Task 5 live smoke after deploy `34663283463`: 11/13 passed. All production auth decisions/statuses are correct; runner falsely fails successful tenant access because it calls an ordinary tenant resource lacking smoke metadata, and falsely demands claim metadata from expected 403 mismatch denial.
- Ruling: Use guarded App tenant auth-check route for positive tenant verification and assert its resolved app tenant ID; validate claim metadata only on expected 200 authenticated checks, never expected denial bodies. Cost if wrong: smoke no longer expects diagnostic claims in generic resource/denial responses.
- Task 5d: complete (commit `83b2294`, review clean)
- Task 4: complete — exact-event Svix endpoint active, Secret Manager version 4 sole active version, signed production delivery/replay verified.
- Task 5: complete — production smoke passed 13/13 after CI `34662593958`, deploy `34663283463`, and Cloudflare apply `34661292159`; temporary sign-in sessions revoked, bridge stopped, and all token/secret/sign-in artifacts deleted.
- Final review: Important — Clerk webhook pre-parser buffers request body without a byte limit before Fastify parsing. Minors — psql child receives full parent environment; direct Foundry provisioning caller can skip membership verification; bootstrap conflict predicates use NULL-unsafe `<>`.
- Final fix wave: original Important and three Minors addressed in `032819c`; review clean for those findings.
- Final fix wave: residual oversized content-length stream cleanup finding addressed in `70aa7cb`; scoped re-review clean.
- Final review: complete, no open Critical/Important/Minor findings.
- Final production probe: 1,048,577-byte webhook request returned Cloudflare `502` while App logged `413`; explicit `payload.destroy()` reset Tunnel upstream before response delivery. App remained healthy.
- Ruling: On oversized declared content length, call `payload.resume()` to drain without buffering, then return `413`; do not destroy socket-backed request payload before response. Cost if wrong: rejected request bytes may continue consuming inbound bandwidth briefly, bounded by server/Tunnel timeouts, but memory stays bounded and client receives required status.
- Final fix wave: stream cleanup round 2 (`5a88b8f`) replaced destructive abort with drain; strengthened full-body TCP test exposed response race.
- Final fix wave: stream cleanup round 3 (`2ebd8ca`) awaits bounded-memory drain before `413`; full 1 MiB+1 TCP body receives clean `413`; scoped re-review clean.
