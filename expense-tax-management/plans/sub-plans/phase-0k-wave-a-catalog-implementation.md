# Phase 0K Wave A: Foundry Provider/Model Catalog — Implementation Plan

**Goal:** Foundry owns `ProviderConnection`, `AiModel`, `AiMode`, `AiModeRouteVersion`, `FoundryAuditEvent` with platform-operator CRUD. First real Foundry domain/routes beyond health scaffolding.

**Spec:** `phase-0i-polyglot-platform-rebaseline-design.md` §11.1, §11.4 (secret handling).

## Scope decisions (following established precedent, not re-litigating)

1. **Secret boundary, not real GCP Secret Manager yet** (GCP is infra-gated). `SecretStore` interface (`store(value) -> reference`, `describe(reference) -> exists`) with a local Postgres-backed default impl (`foundry.provider_secrets`, a table with NO read route exposing values — only `describe`/existence-check is reachable, never the value). Swap for a GCS-backed impl when the infra gate opens, matching Phase 0D's storage-adapter philosophy. Request bodies accept a write-only `secretValue` field; responses only ever return the opaque `secretReference`, never the value — matches design doc §11.4 "write-only request fields... redacted responses" and the `providerApiKey`/`providerCredentials` redaction already present in `app.ts`'s log scrubbing.
2. **Authorization role**: `catalog_manager`, via Foundry's existing (currently unused) `platformGuard(requiredRole)`.
3. **Curated modes/operations**: `AiMode.operation` is `RECEIPT_OCR | AI_SEARCH` per design doc "Operations initially include...". Route versions are immutable once created (same "flip is_current" pattern as `plan_versions` in Phase 0J1).
4. **FoundryAuditEvent** included in this wave (not Wave B) since catalog CRUD needs auditing immediately — mirrors App API's `app_audit_events`/`recordAuditEvent`.
5. Wave B (`TenantAiQuota`, `AiQuotaPeriod`, `AiQuotaReservation`, `ProviderCallLog`, reservation state machine, entitlement sync from App API's outbox) follows as its own plan once this is verified — same reasoning as Phase 0J's wave split.

## Files

- `services/foundry-service/src/database/migrations/002_provider_catalog.ts` — 6 tables (5 + secrets)
- `services/foundry-service/src/database/types.ts` — add table types
- `services/foundry-service/src/errors.ts` — add `DomainError` class + handler recognition (mirrors `services/app-api/src/errors.ts` exactly; Foundry currently has none)
- `services/foundry-service/src/domain/audit.ts` — `recordAuditEvent` (mirrors App API's)
- `services/foundry-service/src/domain/secrets.ts` — `SecretStore` interface + local Postgres-backed default impl
- `packages/contracts/src/foundry-catalog.ts` — Zod schemas
- `services/foundry-service/src/domain/catalog.ts` — CRUD domain logic
- `services/foundry-service/src/routes/catalog.ts` — routes, all `platformGuard("catalog_manager")`
- `services/foundry-service/src/app.ts` — wire domain + routes
- `services/foundry-service/test/catalog.test.ts` — route/auth unit tests (mirrors `services/app-api/test/plans.test.ts` pattern, adapted for `platformGuard`)
- `test/integration/foundry-domain-catalog.test.ts` — real-Postgres integration tests (mirrors `test/integration/app-domain-0j1.test.ts` pattern)
- `scripts/verify-phase-0k-wave-a.mjs` + `package.json` script

## Schema (`002_provider_catalog.ts`)

```
foundry.provider_secrets       (id uuid PK, value text NOT NULL, created_at)
                                -- no update/delete route; rotate = new row + new reference
foundry.provider_connections   (id uuid PK, key text UNIQUE, provider_kind text CHECK IN
                                ('openai','openrouter','anthropic','google','paddleocr'),
                                display_name text, secret_reference uuid NOT NULL
                                REFERENCES provider_secrets(id), status text DEFAULT 'active'
                                CHECK IN ('active','disabled'), created_at, updated_at)
foundry.ai_models              (id uuid PK, provider_connection_id FK, provider_model_id text,
                                metered_model_key text, status text DEFAULT 'active'
                                CHECK IN ('active','disabled'), created_at,
                                UNIQUE(provider_connection_id, provider_model_id))
foundry.ai_modes               (id uuid PK, key text UNIQUE, display_name text, description text,
                                operation text CHECK IN ('RECEIPT_OCR','AI_SEARCH'),
                                status text DEFAULT 'active' CHECK IN ('active','disabled'),
                                created_at)
foundry.ai_mode_route_versions (id uuid PK, ai_mode_id FK, version_number int, ai_model_id FK,
                                is_current bool DEFAULT false, created_at,
                                UNIQUE(ai_mode_id, version_number),
                                UNIQUE INDEX one-current-per-mode WHERE is_current)
foundry.foundry_audit_events   (id uuid PK, actor_platform_subject text, actor_service_principal
                                text, action text, outcome text CHECK IN
                                ('success','denied','failure'), resource_type text,
                                resource_id text, request_id text, metadata jsonb, created_at)
```

No seed data this wave (operators create their own provider/model/mode catalog; unlike Phase 0J1's trial plan, there's no sensible universal default here).

## Routes (all under `/internal/v1/`, `platformGuard("catalog_manager")`)

| Method | Path |
|---|---|
| POST | `/internal/v1/provider-connections` |
| GET | `/internal/v1/provider-connections` |
| PATCH | `/internal/v1/provider-connections/:id` (status/display_name/secret rotation only) |
| POST | `/internal/v1/ai-models` |
| GET | `/internal/v1/ai-models` |
| POST | `/internal/v1/ai-modes` |
| GET | `/internal/v1/ai-modes` |
| POST | `/internal/v1/ai-modes/:aiModeId/route-versions` |

No tenant-facing routes this wave — "curated mode" visibility to Capture users is Wave B's concern (quota status endpoint shows which modes are usable).

## Verification

Same zero-skip aggregate pattern as `verify-phase-0j1.mjs`: cascade through existing verifiers, add Foundry catalog contract/route/integration tests, migration-through-002 via `foundry-service-migrate`, Foundry Docker build + readiness probe.
