# Expense Tax Management - Master Plan

> **Status:** Production foundation complete. Release 2026-10-05 (`main` `d7426e5`, expense only) is deployed: Phases 3B, 3C, 3D-A/B/C, runtime migration Task 7 Stage A/B with shared Temporal active, and family-config runtime env (Firestore `family-config`, `common/config/family_config.py`). Runtime migration is complete: generation 2 routes all jobs to the TypeScript `workflow-worker` (2026-10-06), and Stage C removed the Python worker (2026-10-07, `main` `f20c451`). Connected mailbox (Phase 3D/4) is live since 2026-10-08/09 with `MAILBOX_FEATURE_ENABLED=true`. Incomplete Capture OCR review Phases 1-6 were released on 2026-10-24 through PR #161 (`main` `c6af31a`); Expense Tax CI run `40107180521` passed including E2E, Expense Tax Deploy run `40108519887` succeeded, and authenticated production browser acceptance was owner-approved. Open items are listed under Open Operations.
> **Last updated:** 2026-10-24
> **Source of truth:** This file tracks phase state. Completed implementation details were removed after verification and remain available in git history.

## Handoff

- Runtime migration complete: Tasks 1-7 merged (#12, #14, #35); operator cutover done 2026-10-06 (generation 2); Stage C Python removal released 2026-10-07 (#36, `main` `f20c451`).
- Phase 3D-A/B/C merged (#15, #16, #17), released inert on 2026-10-05, and live since 2026-10-08/09 with `MAILBOX_FEATURE_ENABLED=true` (`main` `be7af1e`). The runtime migration Task 7 cutover that 3D-B/3D-C depended on is complete.
- Incomplete Capture OCR review: released through PR #161 (`main` `c6af31a`) on 2026-10-24 from nine expense squash commits: #139 `4cc5204`, #140 `b17b974`, #141 `2c1c8e2`, #142 `676bd7c`, #143 `ea1c605`, #144 `fd0db42`, #145 `39a692d`, #149 `eb79a59`, and #158 `4d1ec4b`. The released expense tree matches `origin/dev`.
- VPS encrypted backup/restore tooling merged (#13); production activation (bucket/IAM provisioning, first real backup, operator restore rehearsal) is operator-only and pending.
- Work on `feature/toby` from current `origin/dev`; create a separate worktree only when explicitly requested.
- Merge only through a pull request to protected `dev`; required quality CI must pass. Integration CI is advisory and must be reported when red.
- `main` remains production-only. Merges to `dev` never deploy production.
- Read `expense-tax-management/AGENTS.md` before implementation.
- Ordered owner runbook for activating everything below in production: [production-activation-runbook.md](production-activation-runbook.md).

## Product Goal

Self-hosted expense management for households, freelancers, and small businesses:

- Phone/tablet receipt capture and forwarded or connected-mailbox intake.
- Explicit Personal or Business expense scope with membership authorization.
- Project cost analysis without treating projects as tax entities.
- US federal tax preparation and deterministic exports; no direct filing.
- Office review for expenses, duplicates, tags, tax categories, and mailbox candidates.
- Foundry-owned AI routing and quotas, with no user-managed provider keys.

## Current Architecture

```text
Capture Web -----\
                  +--> App API (Fastify/Zod/Kysely) --> app PostgreSQL
Office Web ------/                |
                                  +--> Temporal TypeScript client
                                             |
                                             v
                                  TypeScript workflow-worker (shared Temporal,
                                  namespace expense-tax) --> signed storage adapter
                                             |                 (local now; GCS pending)
                                             +--> App API callbacks
                                             +--> Foundry internal API
                                             +--> Mailbox broker (VPS container) --> Gmail API

Foundry Web ----------> Foundry Service (Fastify/Zod/Kysely)
                                  |
                                  +--> foundry PostgreSQL
                                  +--> Secret Manager
```

- App API owns all customer-domain persistence.
- Foundry owns provider catalog, routing, quotas, reservations, and telemetry.
- TypeScript Temporal workers (`services/workflow-worker`) own durable workflows and data processing, never App or Foundry database writes. The Python worker is removed from code, CI, and production.
- Zod contracts are canonical; generated artifacts are read-only.
- `expense-service/` and `frontend/web/` are transitional legacy surfaces and remain untouched.

## Completed Phases

- **Phase 0 - Core baseline:** TypeScript service rebaseline, Personal/Business/tax domain, plans and entitlements, Foundry catalog and quotas, Temporal worker, OCR, uploads, reports/exports, forwarded intake, Capture/Office/Foundry frontends, and UI gates complete.
- **Phase 1A - Polyglot CI:** Contracts, services, workers, and frontends run in GitHub Actions; integration coverage remains visible as a separate job.
- **Phase 1B - Private production auth/deployment:** Six immutable images deploy to VPS through GitHub OIDC/WIF and one Secret Manager bundle. Clerk identities, PostgreSQL mappings, signed webhook, and authenticated smoke verification complete.
- **Phase 1C - Gateway hardening:** Cloudflare free-tier Tunnel/DNS, explicit host/path ingress, loopback-only origins, bounded application rate limits/body limits, security headers, and fail-closed route checks complete.
- **Phase 1D - Protected development:** `dev` is default and protected; `feature/* -> dev` PRs require `Contracts, services, workers, frontends`; integration is advisory; production deployment remains `main`-only.
- **Phase 3B - Deduplication:** Scoped provenance, deterministic duplicate evidence, pending-review matches, transactional resolution, Office review, and production deployment complete.
- **Runtime TypeScript Temporal migration:** Tasks 1-7 merged; generation 2 cutover 2026-10-06; Python worker removed 2026-10-07 (#35/#36, `main` `f20c451`). Rollback cannot restore the Python worker.
- **Phases 3C and 3D-A/B/C - Auto-tagging and connected mailbox:** released 2026-10-05; mailbox live 2026-10-08/09 (see Remaining Work and the 3D Operator Activation sections).
- **Incomplete Capture OCR review, Phases 1-6:** released on 2026-10-24 through PR #161 (`main` `c6af31a`) with the expense tree identical to `origin/dev`; CI run `40107180521` passed including E2E, deploy run `40108519887` succeeded, and owner-approved authenticated production acceptance passed.

## Remaining Work

| Order | Phase | Status | Canonical documents |
|---|---|---|---|
| Parallel | **TypeScript Temporal worker migration** | Complete: Tasks 1-7 merged (#12, #14, #35); generation 2 cutover 2026-10-06; Stage C released 2026-10-07 (#36, `main` `f20c451`) | [migration plan](sub-plans/runtime-typescript-temporal-migration.md) / [historical handoff](HANDOFF.md) |
| Parallel | **Local Clerk development bootstrap** | Development credentials, M2M checks, local Compose stack (PostgreSQL/Temporal/both workers), and a reproducible dual-generation worker smoke complete; local frontend sign-in and local Clerk webhook remain owner-action-required | [sub-plan](sub-plans/local-clerk-development-bootstrap.md) |
| Parallel | **VPS encrypted backup and restore tooling** | Merged (#13); production activation (bucket/IAM provisioning, first backup, operator restore rehearsal) pending | [plan](sub-plans/vps-backup-and-restore.md) |
| 1 | **3C - Auto-tagging and categorization** | Deployed in the 2026-10-05 release (`main` `d7426e5`; `dev` commits `a4ae60b`..`14bd9df`) | [spec](../../docs/superpowers/specs/2026-09-12-phase-3c-auto-tagging-design.md) / [implementation plan](../../docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md) |
| 2 | **3D-A - Mailbox broker and connection lifecycle** | Merged (#15); deployed inert 2026-10-05; live since 2026-10-08/09 (`MAILBOX_FEATURE_ENABLED=true`, `main` `be7af1e`) | [shared spec](../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md) / [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md) |
| 3 | **3D-B - Mailbox discovery and review** | Merged (#16); live since 2026-10-08/09; daily 02:00 scan schedule running | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md) |
| 4 | **3D-C - Mailbox ingestion and provenance** | Merged (#17); live since 2026-10-08/09; Gmail test-account e2e still open (see 3D-C Operator Activation) | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md) |
| Parallel | **Incomplete Capture OCR review, Phases 1-6** | Released 2026-10-24 through PR #161 (`main` `c6af31a`) from #139 `4cc5204`, #140 `b17b974`, #141 `2c1c8e2`, #142 `676bd7c`, #143 `ea1c605`, #144 `fd0db42`, #145 `39a692d`, #149 `eb79a59`, and #158 `4d1ec4b`; CI `40107180521` passed including E2E; deploy `40108519887` succeeded; released expense tree matches `origin/dev`; authenticated production acceptance owner-approved | Commit and PR history (no separate plan document in repo) |
| Later | **6A/6B/6C - SQL, semantic, and AI search** | Deferred; replan before execution | `plans/sub-plans/phase-6*.md` |
| Later | **9A/9B/9C - Graph foundation, ingestion, and search** | Deferred; replan before execution | `plans/sub-plans/phase-9*.md` |
| Later | **12A/12B/12C - Mobile application** | Deferred; framework decision pending | `plans/sub-plans/phase-12*.md` |

## Required Sequence

1. Phase 3C creates App migration `016` and `ExpenseEnrichmentWorkflow`.
2. Runtime migration Task 7 Stage A takes App migration `017`.
3. Phase 3D-A creates mailbox migration `018` and a VPS-container mailbox broker in the Expense production Compose, with a dedicated PostgreSQL token-vault database/roles.
4. Phase 3D-B creates discovery migration `019` and opaque Temporal discovery orchestration on the TypeScript workflow worker.
5. Phase 3D-C creates ingestion migration `020` and direct broker-to-App materialization.
6. Done: the runtime migration Task 7 cutover (`sub-plans/runtime-typescript-temporal-migration.md`, generation 2 on 2026-10-06) preceded 3D activation, since 3D workflows run only on the TypeScript worker.
7. Done: Phase 3C/3D released 2026-10-05; mailbox activated 2026-10-08/09.

### 3D-A Operator Activation (completed 2026-10-08/09)

The mailbox feature is live for the owner's family tenant (`MAILBOX_FEATURE_ENABLED=true`). The list below is the activation record in order. `expense-tax-management/AGENTS.md` (Current Production) records the resulting state: Clerk M2M machines, the Gmail OAuth client, and the enabled flag. This repo does not log vault bootstrap or the Cloudflare apply as separate records:

1. **Vault bootstrap** — run `deploy/production/bootstrap-mailbox-vault-db.sh` against the production Postgres cluster to create the token-vault database and its separate runtime (DML-only) / migration (DDL-only) roles. Operator-only; never run by normal deploy.
2. **Clerk mailbox identities** — provision the three real machine identities (`app-api-mailbox`, `workflow-worker-mailbox`, `mailbox-broker-app`) in production Clerk, then store their audience, subjects, and machine secret keys in the Firestore production profile (`common/config/family_config.py set expense-tax-management/production <NAME>`).
3. **Google OAuth client** — create the production Google OAuth 2.0 client (Gmail readonly scope only) and store `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in the same profile.
4. **Production profile with `MAILBOX_FEATURE_ENABLED=true`** — set every remaining mailbox key in `expense-tax-management/production` (vault keys, broker URLs, vault database URLs, and `MAILBOX_SERVICE_TOKEN_*`/`MAILBOX_SERVICE_JWKS_URL` equal to the Clerk values), then set `MAILBOX_FEATURE_ENABLED` to `true` last. `deploy.sh` (`validate_required_values`) refuses an enabled profile with missing or mismatched values.
5. **Cloudflare Terraform apply** — run `terraform plan`/`apply` in `infrastructure/cloudflare/expense-tax/` (via `.github/workflows/expense-tax-cloudflare.yml`'s production-environment, manually-dispatched job) to create the `expense-mailbox.tobytran.dev` DNS record and Tunnel ingress rule for `/oauth/google/callback`.

The runtime migration Task 7 cutover (2026-10-06) happened before this activation, as the 3D workflows require.

### 3D-B Operator Activation (completed 2026-10-08/09; the owner's Gmail has a daily 02:00 scan schedule)

3D-B's scheduled scans do not start themselves: nothing calls `ensureMailboxSchedule` automatically (by design — reconciliation over import-time creation). After `MAILBOX_FEATURE_ENABLED` is turned on and runtime migration Task 7 cutover has happened, an operator must run `node dist/temporal/mailbox-schedule-reconcile.js reconcile` (`services/app-api/src/temporal/mailbox-schedule-reconcile.ts`) once to create the daily `02:00` Temporal Schedule for every existing active/scan-enabled connection; re-running it later is safe (idempotent) and is how a newly-connected mailbox's schedule gets created going forward until a startup hook replaces this manual step.

### 3D-C Operator Activation (items 1-2 done; item 3 open)

3D-C source is feature-complete and phase-verified against real PostgreSQL (`test/integration/app-domain-3d-c-mailbox.test.ts`, gated `PHASE_3D_C_T7_INTEGRATION=1`, wired into the zero-skip CI chain). Production ingestion went live with the 3D-A/3D-B activation steps above:

1. **Done:** runtime migration Task 7 cutover (2026-10-06). `MailboxMaterializeWorkflow`/`MailboxOcrReceiptWorkflow` run only on the TypeScript `services/workflow-worker`.
2. **Done:** 3D-A activation (2026-10-08/09) and 3D-B's schedule. The first real Gmail receipt became an expense on 2026-10-10.
3. **Open:** real Gmail test-account verification (plan Task 7 Step 6, `test/e2e/connected-mailbox.e2e.test.ts`) — operator-gated, never run in CI. The 2026-10-10 real run is recorded only through the resolve step. Complete this before enabling `connected_mailbox_scan` for any tenant other than the family tenant.

## Remaining-Phase Constraints

- Phase 3C uses deterministic rules and tenant history only. No live LLM, embeddings, paid provider, or automatic spending/tax-category acceptance.
- Rule tags may auto-apply; historical tags and spending/tax-category suggestions require review.
- Tax automation suggests category only, never deductible percentage, filing treatment, or reviewed status.
- Phase 3D supports Gmail first through a provider adapter; Outlook remains unsupported until separately implemented.
- Gmail scope is exactly `https://www.googleapis.com/auth/gmail.readonly`.
- OAuth refresh tokens are stored as AES-256-GCM ciphertext in a dedicated PostgreSQL token-vault database. Plaintext tokens never enter Temporal history, browsers, logs, or VPS files, and exist only in broker memory.
- Mailbox attachment bytes and provider metadata bypass Temporal; workflows carry opaque IDs and counts only.
- Phase 3B duplicate candidates remain pending review and never auto-merge.
- Mailbox broker runs as a VPS container in the Expense production Compose; no new GCP compute, no static GCP key.

## Production Snapshot

- Public edge: Cloudflare free-tier Tunnel and DNS.
- Origins: VPS application ports bound to loopback only.
- Services: App API, Foundry Service, TypeScript `workflow-worker`, mailbox broker (VPS container), shared Temporal (`family-temporal`), Capture Web, Office Web, and Foundry Web deployed through `.github/workflows/expense-tax-deploy.yml`.
- Authentication: Clerk user, organization, platform, and M2M boundaries verified; production smoke passed 13/13.
- Webhook: exact supported Clerk events active; signed delivery and replay verified.
- Secret handling: one non-destroyed production Secret Manager bundle version; no repository secrets.
- Infrastructure status and deferred operations: [ROADMAP.md](ROADMAP.md).

## Open Operations

Not done. Do not mark these complete without recorded evidence:

- VPS encrypted backup activation: Task 1 Terraform, writer key, and `bootstrap.sh --only backup` (see [ROADMAP.md](ROADMAP.md)).
- Task 8 recovery operations: the live recovery drill (`sub-plans/vps-backup-and-restore.md`, Task 8) has not run against real infrastructure.
- Cloudflare credential rotation after plan-artifact exposure (`production-activation-runbook.md` §1, R.1-R.3): completion is not recorded in this repo.
- Gmail test-account e2e verification (3D-C Operator Activation, item 3).
- Local Clerk development webhook and frontend sign-in checks.
- Remaining Incomplete Capture live acceptance: `no_tax`, 409/412 conflict edit preservation, cross-device review list, keyboard and error-summary focus, and phone-width overflow. Automated component and unit coverage exists; live checks are deferred.
- Deferred, not started: Phases 6A-6C (SQL, semantic, and AI search), 9A-9C (graph), 12A-12C (mobile application). Replan before execution.

## Known Local Limitations

- `test/integration/app-domain-task7-dispatch-routing.test.ts` builds host-TCP PostgreSQL URLs (`createAppDatabase` with a loopback host and published port). CI passes with the PR #149 isolation fix (`eb79a59`), but local execution is blocked by the no-host-TCP database rule. Verify this test in CI until it stops using host TCP.

## Durable Boundaries

- Every customer resource carries explicit Personal or Business scope; tenant administration alone grants no expense access.
- Foundry rejects tenant tokens; platform authorization remains PostgreSQL-owned.
- Manual user decisions outrank accepted historical decisions, which outrank deterministic automation.
- Every remote write or production mutation requires explicit execution-time confirmation.
- Cloudflare paid WAF/rate limiting/Workers/Access and always-on GCP compute require separate cost approval.
