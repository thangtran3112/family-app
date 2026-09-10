# Clerk Authentication Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace self-issued/placeholder authentication with Clerk-backed tenant, platform, and service token boundaries while preserving PostgreSQL authorization.

**Architecture:** Clerk issues user sessions and M2M tokens; App API and Foundry verify issuer, exact audience, signature, time claims, and token type. PostgreSQL maps Clerk user/org IDs to existing UUID tenants, memberships, businesses, and platform operators. Frontends request Clerk JWT templates, while the worker uses short-lived M2M credentials server-side.

**Tech Stack:** Clerk Next.js SDK, Clerk Backend SDK, `jose`, Fastify, PostgreSQL/Kysely, Next.js App Router, Vitest, GitHub/GCP Secret Manager.

**Spec:** `docs/superpowers/specs/2026-09-10-clerk-auth-integration-design.md`

## Global Constraints

- Clerk is sole external identity provider for tenant users and platform staff.
- One Clerk Organization maps to one application `Tenant`.
- PostgreSQL remains authoritative for tenants, memberships, profile/business ownership, platform roles, plans, and entitlements.
- Existing UUID relationships remain unchanged; Clerk IDs are unique external references.
- No bearer tokens in browser assets; Clerk frontend SDK requests short-lived tokens.
- Do not contact Clerk APIs or mutate Clerk configuration until Clerk account credentials are supplied.
- Do not expose public DNS, gateway, TLS, or application ports during this plan.
- Keep Task 10 decisions for public hostnames/gateway, object storage, provider activation, and future compute placement pending.
- Preserve unrelated `plans/mockups/**` worktree changes; stage exact paths only.

---

### Task 1: Add Clerk Configuration Contracts

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

### Task 2: Make App and Foundry Verifiers Clerk-Compatible

**Files:**
- Modify: `expense-tax-management/services/app-api/src/auth/verifier.ts`
- Modify: `expense-tax-management/services/foundry-service/src/auth/verifier.ts`
- Modify: corresponding auth types and tests

**Interfaces:**
- `createTokenVerifier` continues enforcing exact issuer/audience/RS256/time claims.
- User token ID accepts `jti` or Clerk `sid`; service client ID accepts `client_id` or Clerk `azp`.
- App tenant token requires verified email claims only where configured; platform role extraction maps Clerk role claims into existing `roles` arrays.

- [ ] Add failing signed-token fixtures for `sid`, `azp`, Clerk organization claims, platform role, exact audience, wrong audience, and expired tokens.
- [ ] Run auth tests and verify new Clerk fixtures fail before implementation.
- [ ] Implement narrow fallback claim parsing without weakening issuer, audience, signature, or token-type checks.
- [ ] Ensure service routes reject tenant/platform tokens and tenant routes reject service tokens.
- [ ] Run App API and Foundry auth suites.

### Task 3: Add Clerk Identity Mapping Migrations and Domains

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

### Task 4: Add Signed Clerk Webhook Synchronization

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

### Task 5: Integrate Clerk Into Capture, Office, and Foundry Web

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

### Task 6: Add Server-Side M2M Worker Authentication

**Files:**
- Modify: `expense-tax-management/services/ai-worker/src/auth/client.py` or existing client module.
- Modify: App API/Foundry client configuration and tests.
- Modify: production bundle key contract for Clerk machine secret names.

**Interfaces:**
- Worker obtains short-lived Clerk M2M JWTs using server-only credentials and caches until expiry.
- App API and Foundry clients send matching service audience tokens.
- No Clerk secret or M2M token enters browser configuration.

- [ ] Add failing tests for token acquisition, expiry refresh, cache reuse, wrong audience, and missing credential failure.
- [ ] Run worker tests before implementation.
- [ ] Implement token client with bounded timeout, no token logging, and in-memory cache only.
- [ ] Add service-client integration fixtures validating App API/Foundry route guards.
- [ ] Run Python worker and TypeScript service auth tests.

### Task 7: Clerk Account Configuration Gate

**Files:**
- Runtime/config only; no repository secret values.

**Stop condition:** Stop before this task’s external mutations until user supplies Clerk account credentials or explicitly provides a Clerk API key through an approved secure channel.

- [ ] User supplies Clerk instance domain, publishable key, secret key, and machine secret if M2M API requires it.
- [ ] User supplies webhook signing secret after creating webhook endpoint configuration.
- [ ] Configure JWT templates `expense-app`, `expense-foundry-platform`, and service audience templates.
- [ ] Configure Clerk Organization behavior and initial Family organization.
- [ ] Verify token claims against local verifier fixtures and private VPS endpoints.

### Task 8: Private Authenticated Smoke Test

**Files:**
- Test/config/runtime only.

- [ ] Create or import two approved Clerk users and one Family organization through Clerk dashboard/API.
- [ ] Confirm webhook mapping creates/updates local user, tenant, and membership rows.
- [ ] Authenticate Capture/Office privately and verify App API tenant ownership.
- [ ] Authenticate Foundry privately and verify platform role authorization.
- [ ] Run worker M2M smoke path with fake provider only; do not activate paid OpenAI/OpenRouter calls.
- [ ] Record exact successful commit/run/runtime evidence, then stop before public gateway decisions.
