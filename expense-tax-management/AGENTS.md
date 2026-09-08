# AGENTS.md - Expense Tax Management

> Project-level rules and context for AI agents working on this codebase.

## Current Architecture

- App API and Foundry are Fastify/Zod/Kysely services.
- Python is worker-only and cannot access App/Foundry PostgreSQL.
- Zod contracts are canonical; generated files are read-only.
- Every customer resource requires explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry tenant tokens are always invalid.
- Runtime and migration database credentials are separate.
- Transitional `expense-service` and `frontend/web` remain untouched until their owning cutover phases.
- Frontend mockup gates remain application-specific.

## Phase State

- Phase 0I complete: TypeScript App/Foundry baseline, canonical contracts, isolated PostgreSQL ownership, auth boundaries, generated artifacts, and local Compose verification.
- Phase 0J Waves 1-4 complete locally: identity/tenants/memberships, industry-specific businesses/categories/projects, expenses, 2025 Schedule C taxonomy, tax profiles/treatments, and cursor-paginated ledgers.
- Phase 0J1 complete locally: Plan/PlanVersion/FeatureDefinition/PlanEntitlement (platform-operator CRUD via service scope `plans:manage`, principal `platform-admin`), TenantSubscription/TenantAddon (tenant owner self-service), effective-entitlement precedence resolution (override > addon > plan), and an entitlement-snapshot outbox polled by Foundry (`foundry-service` principal, `entitlements:read` scope) — see `plans/sub-plans/phase-0j1-plans-entitlements-implementation.md`.
- Phase 0K complete locally (Waves A+B): Foundry's first real domains beyond health scaffolding.
  - Wave A: ProviderConnection/AiModel/AiMode/AiModeRouteVersion platform-operator CRUD via Foundry's `platformGuard("catalog_manager")`; provider secrets go through a `SecretStore` boundary (`domain/vault.ts`, Postgres-backed for now, GCP Secret Manager swap deferred to the infra gate) — request bodies accept a write-only `secretValue`, responses only ever return an opaque `secretReference`. Route versions are immutable/flip-`is_current` like `plan_versions`. Foundry now has its own `DomainError` (mirrors App API's) and `recordAuditEvent`. See `plans/sub-plans/phase-0k-wave-a-catalog-implementation.md`.
  - Wave B: TenantAiQuota/AiQuotaPeriod/AiQuotaReservation/ProviderCallLog/AiQuotaReservationResolution. Full reservation state machine (RESERVED -> CALL_STARTED -> CONSUMED, with RELEASED and RECONCILIATION_REQUIRED branches), atomic dual-counter (aggregate + model-scoped) check-and-reserve where the aggregate policy can never be bypassed by a model-scoped allowance, dual-approval reconciliation for ambiguous `released` decisions (single approval suffices for `consumed`) via a new `platformGuard("quota_reconciler")` role, and entitlement sync from the Phase 0J1 outbox (`domain/entitlement-sync.ts`, uses the already-generated `createAppApiClient`; disabled entitlements sync as a hard block, not a skip). Worker-facing reservation routes use `serviceGuard("ai-worker", ["reservations:write"])`; quota-status is `serviceGuard("app-api", ["quota-status:read"])` -- App API's own tenant-facing proxy route is deferred until a frontend needs to display it. See `plans/sub-plans/phase-0k-wave-b-quotas-reservations-implementation.md`. Deferred to Phase 0L: reservation "generation"/reacquire-after-expiry, automatic reconciliation-deadline alerting (needs a scheduler), and the actual provider-adapter reconciliation-evidence lookups.
- App API migrations `002_identity_memberships` through `007_plans_entitlements` are applied and verified locally. Foundry migrations `001_service_metadata` through `003_quotas_reservations` are applied and verified locally.
- Final local gates: `PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 PHASE_0J_WAVE3_INTEGRATION=1 PHASE_0J_WAVE4_INTEGRATION=1 PHASE_0J1_INTEGRATION=1 PHASE_0K_WAVE_A_INTEGRATION=1 PHASE_0K_WAVE_B_INTEGRATION=1 pnpm verify:phase-0k:wave-b` (cascades through every prior verifier).
- Final evidence: `.superpowers/sdd/phase-0j-waves-3-4/task-report.md` (Waves 1-4); 0J1, 0K Wave A, and 0K Wave B verified fresh this session (zero skips).
- Naming gotcha for future files: `.dockerignore` has `**/*secret*` and `**/*credentials*` (meant to block real credential files) — any source filename containing those substrings gets silently excluded from every service's Docker build context. Avoid those substrings in filenames; `vault.ts` is the established alternative for secret-handling logic.

## Change Boundaries

- Treat current architecture statements above as authoritative over legacy plans, rules, and directory names.
- Do not add App API or Foundry database access to Python workers.
- Do not edit generated contract or client files directly. Update their Zod sources and regenerate only when task explicitly requires it.
- Keep runtime credentials and migration credentials separate in code, configuration, and documentation.
- Never inspect, print, commit, or expose environment/provider configuration or secrets.
- Preserve every unrelated worktree change.

## Authorization

- Authorize every customer resource with explicit Personal/business scope.
- Tenant role alone never grants profile access.
- Reject Foundry tenant tokens in every Foundry authentication path.

## Transitional Areas

- `expense-service` is transitional. Do not extend or migrate it as part of current App API or Foundry work.
- `frontend/web` is transitional. Do not extend or migrate it as part of current frontend work.
- Leave both areas untouched until their owning cutover phases.

## Frontend Gates

- Frontend mockup gates remain application-specific.
- Complete the applicable mockup preflight before implementing a frontend application. Do not apply one application's gate blindly to another.

## Engineering Rules

- Use tests first for behavior changes. For approved configuration/scaffolding tasks that need no new unit tests, use direct configuration and integration verification instead.
- Preserve existing docstrings and comments unless task explicitly requests changes.
- Use smallest correct diff.
- Use CodeGraph first for framework-oriented source flows and codebase-memory for architecture, boundaries, and impact analysis.
- Treat graph output as navigation evidence, not proof of authorization, tenant isolation, or dynamic dispatch. Verify those claims in source and tests.

## Git Safety

- Do not create feature branches. Work on current branch.
- Do not commit, push, reset, stash, clean, checkout, or switch branches unless explicitly requested.
- Inspect status and diff before editing. Never revert unrelated worktree changes.

## Verification

- Report commands and exact outcomes.
- Do not run `opencode debug config`; resolved output may include provider secrets.
- Restart opencode after changing project configuration, agents, or rules so changes load in a new process.

## Remaining Pre-Infrastructure Work
- `0L`: Python Temporal worker foundation and durable OCR/AI workflow handoff.
- `0D`: App-owned signed upload sessions and local/GCS storage adapter boundary.
- `0C`: receipt capture/OCR pipeline after storage, Foundry, and worker foundations.
- `0E`: business/tax-year reports and export bundles based on completed tax treatment data.
- `0P`: secure forwarded receipt intake and quarantine before OCR.
- `0F0`, `0F`, `0M`, `0N`: application-specific mockup gates and Capture/Office/Foundry frontends.
- `1A`: CI/CD source and verification work may proceed; `1B` VPS deployment and `1C` production gateway hardening wait for infrastructure approval.
- Later search, graph, premium mailbox, and mobile phases remain after core pre-infrastructure capabilities.

## Infrastructure Gate

- Do not mutate VPS, GCP, production databases, gateway routes, DNS, shared infrastructure, or production secrets without explicit deployment approval.
- VPS Postgres is live (approved exception, 2026-09-08): OVH VPS, SSH port 2222 (key-only auth), PostgreSQL 17 + pgvector running in Docker, bound to the VPS's own `127.0.0.1:5432` only — never exposed publicly. Reached from local dev via SSH tunnel to a non-5432 local port (`15432`) so it never collides with the ephemeral Postgres integration tests spin up on `127.0.0.1:5432`. App API and Foundry still run locally; no app/gateway traffic is exposed from the VPS yet.
- Reusable IaC for VPS provisioning now lives at `infrastructure/vps/` (family-app root, shared across apps — not under this app's own tree): `bootstrap.sh` orchestrates idempotent `steps/00-firewall.sh` → `10-harden-ssh.sh` → `20-docker.sh` → `30-postgres.sh` over SSH from the operator machine. Firewall/SSH/Docker steps are verified idempotent against the live OVH box; the shared-Postgres-cluster step is written but not yet run against a real box (today's live Postgres predates it and is not yet migrated onto it — see `infrastructure/vps/README.md` "Tested status" for the exact caveat). That README also documents the one gap that can never be scripted: the manual first-connection bridge to any brand-new VPS.
