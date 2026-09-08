# Phase 0K Wave B: Quotas, Reservations & Entitlement Sync — Implementation Plan

**Goal:** Foundry owns `TenantAiQuota`, `AiQuotaPeriod`, `AiQuotaReservation`, `ProviderCallLog`, reservation resolution; independently enforces runtime AI quotas without sharing tables with App API, fed by the Phase 0J1 entitlement-snapshot outbox.

**Spec:** `phase-0i-polyglot-platform-rebaseline-design.md` §11.1-§11.4.

## Scope decisions (narrowing deliberately, not guessing at unbuilt consumers)

1. **No reservation "generation"/reacquire mechanism this wave.** Design doc describes retrying an already-admitted job under the same idempotency key after an earlier reservation expired, recording a new generation. Nothing calls this yet — no worker exists (Phase 0L). Building it now means designing against zero real usage. Simple `UNIQUE(tenant_id, operation, idempotency_key)` this wave; generation/reacquire is a documented deferred decision for when Phase 0L's worker gives a real retry pattern to design against.
2. **No alerting/escalation-deadline scheduler.** "Foundry alerts before that deadline" needs a scheduler (Temporal, Phase 0L). This wave builds the data model (`RECONCILIATION_REQUIRED` state, resolution table) and the operator-facing resolve API; automatic alerting is deferred alongside Phase 0L.
3. **Dual-approval for ambiguous release, single approval for consume** (design doc: "Ambiguous release requires dual approval" — implies consume doesn't). Modeled as `ai_quota_reservation_resolutions`: one row per approval attempt; a `released` decision only takes effect once two rows exist from two *different* `resolved_by_subject` values; `consumed` takes effect on the first row. New role `quota_reconciler` (Foundry's existing `platformGuard`, same mechanism as Wave A's `catalog_manager`).
4. **Entitlement sync only handles feature keys with a numeric limit.** Of the 6 seeded feature keys, only `ai_search` currently has one (20/month trial). `receipt_forwarding`/`connected_mailbox_scan`/`ocr_mode_*` are boolean product gates enforced entirely in App API, not Foundry quota policies. Sync maps `featureKey -> AiOperation` (`ai_search -> AI_SEARCH`; everything else is skipped, not an error) and upserts an *aggregate* (`ai_model_id IS NULL`) `tenant_ai_quotas` row per synced tenant/operation. Model-scoped quota policies (if ever needed) stay operator-configured, not sync-driven.
5. **Sync cursor stored in the already-existing `foundry.service_metadata` table** (`key='entitlement_sync_cursor'`, `value={afterSequence}`) — no new table needed for this.
6. **Sync is a callable domain function, not a background poller** (same reasoning as Wave A/0J1 — no scheduler exists yet). Accepts a pre-obtained App API service bearer token; token *acquisition* stays out of scope (same as noted for 0J1).
7. **Cost tracking is a plain `numeric` column on `provider_call_logs`, no internal dollar-ceiling enforcement this wave** ("internal dollar safety ceilings remain separate from customer-visible allowances" -- noted as future work, nothing to enforce against yet since there's no real spend data).

## Files

- `services/foundry-service/src/database/migrations/003_quotas_reservations.ts` — 4 tables
- `services/foundry-service/src/database/types.ts` — add table types
- `packages/contracts/src/foundry-quotas.ts` — Zod schemas
- `services/foundry-service/src/domain/quotas.ts` — policy CRUD (`catalog_manager`), reservation lifecycle, resolution (`quota_reconciler`), quota-status query
- `services/foundry-service/src/domain/entitlement-sync.ts` — sync from App API outbox via `createAppApiClient`
- `services/foundry-service/src/routes/quotas.ts` — routes
- `services/foundry-service/src/app.ts` — wire domain + routes
- `services/foundry-service/test/quotas.test.ts`, `test/entitlement-sync.test.ts` — unit tests
- `test/integration/foundry-domain-quotas.test.ts` — real-Postgres integration
- `scripts/verify-phase-0k-wave-b.mjs` + `package.json` script

## Schema (`003_quotas_reservations.ts`)

```
foundry.tenant_ai_quotas
  (id uuid PK, tenant_id uuid, operation text CHECK IN ('RECEIPT_OCR','AI_SEARCH'),
   ai_model_id uuid NULL REFERENCES ai_models(id), period_type text CHECK IN ('monthly','unlimited'),
   max_jobs integer NULL CHECK (max_jobs IS NULL OR max_jobs >= 0), created_at, updated_at,
   UNIQUE (tenant_id, operation, ai_model_id),
   UNIQUE INDEX tenant_ai_quotas_aggregate_unique ON (tenant_id, operation) WHERE ai_model_id IS NULL)
   -- max_jobs NULL + period_type='unlimited' means no cap; NULL period_type never happens (NOT NULL).

foundry.ai_quota_periods
  (id uuid PK, tenant_ai_quota_id uuid FK, period_key text, -- e.g. '2026-09' (UTC month)
   consumed_jobs integer DEFAULT 0, reserved_jobs integer DEFAULT 0, created_at, updated_at,
   UNIQUE (tenant_ai_quota_id, period_key))

foundry.ai_quota_reservations
  (id uuid PK, tenant_id uuid, operation text, ai_model_id uuid NOT NULL REFERENCES ai_models(id),
   -- the RESOLVED model for this specific job (always populated even if the checked
   -- policy is aggregate-only -- every job runs against one concrete model)
   idempotency_key text, status text CHECK IN
     ('RESERVED','CALL_STARTED','CONSUMED','RELEASED','RECONCILIATION_REQUIRED'),
   aggregate_period_id uuid NULL FK ai_quota_periods, model_period_id uuid NULL FK ai_quota_periods,
   created_at, updated_at, call_started_at timestamptz NULL, resolved_at timestamptz NULL,
   UNIQUE (tenant_id, operation, idempotency_key))

foundry.provider_call_logs
  (id uuid PK, reservation_id uuid FK, attempt_number integer CHECK (attempt_number > 0),
   provider_idempotency_key text NULL, outcome text CHECK IN ('accepted','failed','pending'),
   latency_ms integer NULL, cost_usd numeric(10,6) NULL, created_at,
   UNIQUE (reservation_id, attempt_number))

foundry.ai_quota_reservation_resolutions
  (id uuid PK, reservation_id uuid FK, decision text CHECK IN ('consumed','released'),
   reason text NOT NULL, evidence jsonb NULL, resolved_by_subject text NOT NULL, created_at,
   UNIQUE (reservation_id, resolved_by_subject))
   -- unique per (reservation, approver) so the same reconciler can't double-count
   -- their own approval toward the dual-approval requirement for 'released'
```

## Reservation lifecycle (domain functions)

- `reserve({ tenantId, operation, aiModelId, idempotencyKey })`: one transaction. Look up aggregate policy (`ai_model_id IS NULL`) and model policy (`ai_model_id = :aiModelId`) for `(tenantId, operation)`. For each policy found: lazily create/select this UTC month's `ai_quota_periods` row (`SELECT ... FOR UPDATE` to serialize concurrent reservations for the same tenant/period), check `consumed_jobs + reserved_jobs < max_jobs` (skip check if `period_type = 'unlimited'`), increment `reserved_jobs`. If EITHER applicable policy is exhausted, roll back and throw `DomainError.conflict()` (quota exhausted) -- an aggregate cap can never be bypassed by an available model-scoped allowance, matching design doc "Model/route switching cannot bypass the aggregate allowance." Insert the reservation row with `status='RESERVED'`.
- `markCallStarted({ reservationId, providerIdempotencyKey })`: `RESERVED -> CALL_STARTED`, insert a `provider_call_logs` row (`attempt_number` = existing count + 1, `outcome='pending'`). Rejects if not currently `RESERVED`.
- `recordProviderOutcome({ reservationId, attemptNumber, outcome, latencyMs, costUsd })`: updates the matching `provider_call_logs` row. If `outcome='accepted'`: transaction moves BOTH applicable periods' `reserved_jobs -= 1, consumed_jobs += 1` and reservation to `CONSUMED`, `resolved_at=now()`. If `outcome='failed'` and this was the first/only attempt with no prior acceptance: reservation stays `CALL_STARTED` (caller may log more attempts) -- moving to `RECONCILIATION_REQUIRED` is a separate explicit call (`markReconciliationRequired`), not automatic, since only the caller (worker) knows whether the failure was truly connection-level (needs reconciliation) vs. a normal retryable provider error before any call was accepted.
- `markReconciliationRequired({ reservationId })`: `CALL_STARTED -> RECONCILIATION_REQUIRED`. No period counters change (design doc: "it never releases capacity ... until provider records determine billability").
- `release({ reservationId })`: `RESERVED -> RELEASED` only (a `CALL_STARTED` reservation can't be released directly -- it must go through reconciliation once a call has started, matching the design doc's ordering). Decrements `reserved_jobs` on applicable periods.
- `resolveReconciliation({ reservationId, decision, reason, evidence, resolvedBySubject })`: inserts one `ai_quota_reservation_resolutions` row (unique per reservation+subject, so the same reconciler can't submit twice). If `decision='consumed'`: immediately finalizes (`reserved_jobs -= 1, consumed_jobs += 1`, reservation -> `CONSUMED`). If `decision='released'`: checks for a second row with `decision='released'` from a *different* subject; only then finalizes (`reserved_jobs -= 1`, reservation -> `RELEASED`) -- otherwise stays `RECONCILIATION_REQUIRED` pending the second approval. A single reservation can't be finalized twice (idempotent: re-checking status before applying).
- `getQuotaStatus({ tenantId, operation })`: returns remaining jobs and UTC period reset date for the applicable aggregate policy (design doc §11.2: "UI shows remaining jobs and UTC reset date"; provider/model/route details stay hidden -- response never includes `ai_model_id` or policy internals, only `remainingJobs`/`resetsAt`/`isAvailable`).

**Correction caught before implementation**: this is NOT tenant-guarded in Foundry -- "Foundry tenant tokens are always invalid" is an explicit, already-established invariant (Foundry's `AuthVerifiers` only has `platform`/`service`, no `tenant` verifier at all). Tenant-facing visibility means: tenant -> App API (tenant-guarded) -> App API calls this Foundry endpoint (service-scoped) -> relays to tenant. Building the App API-side proxy route + its outbound Foundry-calling client is real extra scope with no frontend consumer yet (ties to whichever frontend phase first needs to display quota status). Deferred; this wave only builds Foundry's service-scoped endpoint.

## Routes

| Method | Path | Guard |
|---|---|---|
| POST | `/internal/v1/tenant-ai-quotas` | `platformGuard("catalog_manager")` |
| GET | `/internal/v1/tenant-ai-quotas` | `platformGuard("catalog_manager")` |
| POST | `/internal/v1/ai-quota-reservations` | `serviceGuard("ai-worker", ["reservations:write"])` (Foundry already has `serviceGuard`; `ai-worker` principal already used in App API tests as the expected future worker identity) |
| POST | `/internal/v1/ai-quota-reservations/:id/call-started` | `serviceGuard("ai-worker", ["reservations:write"])` |
| POST | `/internal/v1/ai-quota-reservations/:id/attempts/:attemptNumber/outcome` | `serviceGuard("ai-worker", ["reservations:write"])` |
| POST | `/internal/v1/ai-quota-reservations/:id/reconciliation-required` | `serviceGuard("ai-worker", ["reservations:write"])` |
| POST | `/internal/v1/ai-quota-reservations/:id/release` | `serviceGuard("ai-worker", ["reservations:write"])` |
| POST | `/internal/v1/ai-quota-reservations/:id/resolve` | `platformGuard("quota_reconciler")` |
| POST | `/internal/v1/entitlement-sync` | `platformGuard("catalog_manager")` (manually triggered until Phase 0L has a scheduler) |
| GET | `/internal/v1/quota-status` | `serviceGuard("app-api", ["quota-status:read"])` (query params: `tenantId`, `operation`) -- App API-side tenant-facing proxy is deferred, see note above |

## Verification

Same zero-skip pattern, cascading through `verify-phase-0k:wave-a`.
