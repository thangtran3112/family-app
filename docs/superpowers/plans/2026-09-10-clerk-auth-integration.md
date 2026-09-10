# Clerk Authentication Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace self-issued/placeholder authentication with Clerk-backed tenant, platform, and service token boundaries while preserving PostgreSQL authorization.

**Architecture:** Clerk issues user sessions and M2M tokens; App API and Foundry verify issuer, exact audience, signature, time claims, and token type. PostgreSQL maps Clerk user/org IDs to existing UUID tenants, memberships, businesses, and platform operators. Frontends request Clerk JWT templates. The worker uses two short-lived, destination-scoped Clerk M2M credentials server-side.

**Tech Stack:** Clerk Next.js SDK, Clerk Backend SDK, `jose`, Fastify, PostgreSQL/Kysely, Next.js App Router, Vitest, GitHub/GCP Secret Manager.

**Spec:** `docs/superpowers/specs/2026-09-10-clerk-auth-integration-design.md`

## Global Constraints

- Clerk is sole external identity provider for tenant users and platform staff.
- One Clerk Organization maps to one application `Tenant`.
- PostgreSQL remains authoritative for tenants, memberships, profile/business ownership, platform roles, plans, and entitlements.
- Existing UUID relationships remain unchanged; Clerk IDs are unique external references.
- No bearer tokens in browser assets; Clerk frontend SDK requests short-lived tokens.
- Never put Clerk secrets in repository files, browser configuration, logs, or chat.
- Do not expose public DNS, gateway, TLS, or application ports during this plan.
- Keep public hostnames/gateway, object storage, provider activation, and future compute placement pending.
- Preserve unrelated `plans/mockups/**` worktree changes; stage exact paths only.

---

### Task 1: Add Clerk Configuration Contracts (Complete)

**Files:**
- Modify: `expense-tax-management/services/app-api/src/config.ts`
- Modify: `expense-tax-management/services/foundry-service/src/config.ts`
- Modify: `expense-tax-management/services/ai-worker/src/config.py`
- Modify: `expense-tax-management/.env.example`
- Test: existing service config tests plus new Clerk config cases

**Interfaces:**
- Produces `CLERK_ISSUER_URL`, `CLERK_JWKS_URL`, tenant/platform/service audiences, and server-only Clerk secret names.
- Keeps test fixtures able to inject fake issuers/JWKS and never requires Clerk credentials during unit tests.

- [ ] Write failing config tests for required Clerk issuer/audience/JWKS values and optional server secrets.
- [ ] Run service config tests and confirm missing Clerk configuration fails with named variable only.
- [ ] Implement typed config parsing with trim, URL validation, and no secret logging.
- [ ] Add `.env.example` entries documenting public publishable-key versus server-only secret boundaries.
- [ ] Run App API, Foundry, and worker config tests plus TypeScript/Python lint.

### Task 2: Make App and Foundry Verifiers Clerk-Compatible (Complete)

**Files:**
- Modify: `expense-tax-management/services/app-api/src/auth/verifier.ts`
- Modify: `expense-tax-management/services/foundry-service/src/auth/verifier.ts`
- Modify: corresponding auth types and tests

**Interfaces:**
- `createTokenVerifier` continues enforcing exact issuer/audience/RS256/time claims.
- User token ID accepts `jti` or Clerk `sid`; service identity validation is completed in Task 6 using signed Clerk machine subjects.
- App tenant token requires verified email claims only where configured; platform role extraction maps Clerk role claims into existing `roles` arrays.

- [ ] Add failing signed-token fixtures for `sid`, Clerk organization claims, platform role, exact audience, wrong audience, and expired tokens.
- [ ] Run auth tests and verify new Clerk fixtures fail before implementation.
- [ ] Implement narrow fallback claim parsing without weakening issuer, audience, signature, or token-type checks.
- [ ] Ensure service routes reject tenant/platform tokens and tenant routes reject service tokens.
- [ ] Run App API and Foundry auth suites.

### Task 3: Add Clerk Identity Mapping Migrations and Domains (Complete)

**Files:**
- Create: App API migration adding unique nullable `clerk_user_id` to users and `clerk_org_id` to tenants.
- Modify: App API database types/domain mapping.
- Create: mapping domain tests.
- Modify: Foundry operator mapping only if current schema has no external operator reference.

**Interfaces:**
- `resolveTenantIdentity(clerkUserId, clerkOrgId)` returns existing app user/tenant mapping or a typed not-provisioned result.
- Unknown/deleted Clerk identities fail closed without creating financial rows.

- [ ] Add failing migration/domain tests for unique IDs, unknown identities, deleted markers, org mismatch, and membership ownership.
- [ ] Run tests before migration/domain implementation.
- [ ] Implement migration and mapping lookup; preserve all existing UUID foreign keys.
- [ ] Implement idempotent mapping behavior for webhook upserts.
- [ ] Run migrations against Docker-local PostgreSQL and full App API database tests.

### Task 4: Add Signed Clerk Webhook Synchronization (Complete)

**Files:**
- Create: `expense-tax-management/services/app-api/src/routes/clerk-webhooks.ts`
- Create: webhook signature/parser module and tests.
- Modify: App API route registration and config.
- Modify: contracts only if webhook response contract is public.

**Interfaces:**
- `POST /api/v1/integrations/clerk/webhook` verifies Clerk signature, event ID, and event type.
- User/org/membership events upsert external references; delete events mark identities deleted without deleting expenses.
- Event ID uniqueness makes retries idempotent.

- [ ] Add failing tests for valid signature, invalid signature, replay, malformed payload, unknown event, retry, and deletion marker.
- [ ] Run webhook tests and confirm failure before implementation.
- [ ] Implement signature verification with server-only `CLERK_WEBHOOK_SIGNING_SECRET` and constant-time checks.
- [ ] Implement transaction boundaries and event-id persistence.
- [ ] Run App API webhook and database tests.

### Task 5: Integrate Clerk Into Capture, Office, and Foundry Web (Complete)

**Files:**
- Modify: each frontend `package.json`, layout/provider, auth routes, session/API helpers.
- Create/modify: `frontend/capture-web/src/lib/clerk.ts`, `office-web/src/lib/clerk.ts`, `foundry-web/src/lib/clerk.ts`.
- Test: frontend auth/token helper tests.

**Interfaces:**
- Capture/Office call App API with `getToken({ template: "expense-app", organizationId })`.
- Foundry calls Foundry Service with `getToken({ template: "expense-foundry-platform" })`.
- Signed-out state renders Clerk sign-in UI; missing token returns unauthorized, never a demo bearer token.

- [ ] Add failing helper tests for signed-out, active organization, token refresh, and no-token API rejection.
- [ ] Install pinned Clerk frontend packages and run focused tests to verify missing imports fail first.
- [ ] Add Clerk provider/configuration without embedding server secrets.
- [ ] Replace production demo-session injection with Clerk session/token retrieval while retaining test fixtures only in tests.
- [ ] Run all frontend lint/typecheck/tests/builds.

### Task 6: Align Server-Side M2M Worker Authentication With Clerk

**Files:**
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/auth/client.py`.
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/config.py`.
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py`.
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/foundry_client.py`.
- Modify: `expense-tax-management/services/app-api/src/auth/verifier.ts` and tests.
- Modify: `expense-tax-management/services/foundry-service/src/auth/verifier.ts` and tests.
- Test: `expense-tax-management/services/ai-worker/tests/test_auth_client.py` and `test_service_clients.py`.
- Test: `expense-tax-management/services/app-api/test/auth.test.ts` and `services/foundry-service/test/auth.test.ts`.

**Interfaces:**
- `ClerkM2MTokenIssuer` posts JSON `{token_format: "jwt", seconds_until_expiration: 300, claims: {scope}}` to `/v1/m2m_tokens` with one destination-specific machine secret.
- `CachedM2MTokenProvider` validates exact singleton `aud` target-machine array, exact `sub` source-machine ID, required scope, and `exp` before caching.
- App API and Foundry clients use separate machine secrets and target-machine audience values.
- Service guards authorize signed `sub` machine identity and route scope; `client_id`/`azp` are not service authorization anchors.

- [ ] Add failing tests for JSON-body request shape, JWT response extraction, singleton audience, source subject, wrong audience, wrong subject, expiry refresh, cache reuse, and missing credential failure.
- [ ] Run focused worker/auth tests and confirm these new cases fail before implementation.
- [ ] Implement bounded-timeout token issuance, strict Clerk-native claim validation, and destination-specific in-memory caches without logging secrets or tokens.
- [ ] Update App API and Foundry service guards/configuration to require their expected source machine ID.
- [ ] Run worker, App API, and Foundry auth/client test suites plus lint/typecheck.

### Task 7: Configure Clerk Development M2M Topology

**Files:**
- External Clerk development instance only; no repository files.
- Evidence: `.superpowers/sdd/2026-09-10-clerk-auth-integration/clerk-m2m-contract.json` with IDs only, never secrets or tokens.

**Interfaces:**
- Target machines: `app-api` and `foundry-service`.
- Source machines: `ai-worker-app` scoped only to `app-api`, and `ai-worker-foundry` scoped only to `foundry-service`.
- Each source machine produces JWTs with one target machine ID in `aud` and its own source machine ID in `sub`.

- [ ] Create or rename source machines so exactly two source identities exist for worker use; do not delete an existing machine without explicit confirmation.
- [ ] Create target machines `app-api` and `foundry-service` with no outgoing scopes.
- [ ] Grant only `ai-worker-app -> app-api` and `ai-worker-foundry -> foundry-service` scopes.
- [ ] Capture machine IDs and issuer/JWKS URLs in the evidence file; write each one-time secret to a mode-0600 local file without printing it.
- [ ] Mint one five-minute JWT per source using JSON request fields and record only non-secret claim metadata: `iss`, `sub`, singleton `aud`, `scope`, `jti` presence, and `exp` presence.
- [ ] Revoke probe tokens after claim validation; keep no token response files.

### Task 8: Wire Clerk Runtime Secrets and Machine IDs

**Files:**
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/config.py`.
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py`.
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/foundry_client.py`.
- Modify: `expense-tax-management/.env.example`.
- Modify: `expense-tax-management/docker-compose.yml` and `deploy/production/docker-compose.yml`.
- Modify: `expense-tax-management/scripts/lib/production-secret-bundle.mjs` and tests.
- Test: worker config/client tests and production secret bundle tests.

**Interfaces:**
- Secrets: `CLERK_APP_MACHINE_SECRET_KEY`, `CLERK_FOUNDRY_MACHINE_SECRET_KEY`.
- Nonsecrets: `CLERK_APP_SERVICE_AUDIENCE`, `CLERK_FOUNDRY_SERVICE_AUDIENCE`, `CLERK_APP_SERVICE_SUBJECT`, `CLERK_FOUNDRY_SERVICE_SUBJECT`.
- Secret Manager receives both real machine secrets in one new bundle version; prior version remains until access verification succeeds, then is destroyed per existing policy.

- [ ] Add failing bundle/config tests requiring both machine secrets and all four machine IDs.
- [ ] Run focused bundle/config tests and confirm missing-key failures name only the missing variable.
- [ ] Implement separate provider wiring and production Compose/bundle propagation.
- [ ] Verify machine secrets are absent from frontend packages, generated assets, logs, and test output.
- [ ] Run worker/config/bundle tests, lint, typecheck, and `git diff --check`.

### Task 9: Configure Clerk Development Users, Organization, and Webhook Gate

**Files:**
- External Clerk development instance only.
- Runtime evidence: `.superpowers/sdd/2026-09-10-clerk-auth-integration/clerk-account-contract.json` with IDs, URLs, and claim names only.

**Interfaces:**
- One Clerk Organization named `Family` maps to one application tenant.
- Two approved Clerk users belong to `Family`; Foundry operator roles remain application-owned unless a platform role claim is explicitly configured.
- Webhook remains uncreated until a reachable HTTPS endpoint exists; private VPS loopback is not a valid Clerk delivery target.

- [ ] Create `Family` organization in the development instance.
- [ ] Create/import exactly two approved test users without placing credentials in repository or chat.
- [ ] Configure `expense-app` and `expense-foundry-platform` templates as recorded in the approved spec.
- [ ] Do not create a webhook endpoint until a reachable HTTPS hostname is approved; record this as deferred if no endpoint exists.
- [ ] Record external IDs only, never passwords, session tokens, machine secrets, or webhook secrets.

### Task 10: Run Private Authenticated Smoke Test and Final Review

**Files:**
- Runtime/test evidence only; no public gateway changes.
- Evidence: `.superpowers/sdd/2026-09-10-clerk-auth-integration/smoke-test.md`.

- [ ] Install real development issuer/JWKS URLs and public publishable keys only in approved local/runtime secret channels.
- [ ] Run database migrations and confirm webhook-independent mapping prerequisites without inventing production identities.
- [ ] Authenticate Capture and Office privately with `expense-app`; verify App API tenant ownership and organization mismatch rejection.
- [ ] Authenticate Foundry privately with `expense-foundry-platform`; verify platform role authorization and signed-out behavior.
- [ ] Run worker App API and Foundry M2M calls using fake provider behavior only; do not activate paid OpenAI/OpenRouter calls.
- [ ] Run complete test/lint/typecheck/build and review all Tasks 1-10 changes.
- [ ] Stop before public DNS/gateway/TLS, production Clerk instance, or paid provider activation.
