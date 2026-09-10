# Final Fix Wave Evidence

Date: 2026-09-10
Review: `final-review.md`

## Scope

All seven final-review findings addressed in one local, non-deployed fix wave.
Unrelated `plans/mockups/**`, generated frontend environment files, agent files,
and `task-5-report.md` were not staged.

## Fixes

1. Worker Compose startup configuration
   - Added `CLERK_ISSUER_URL`, `CLERK_JWKS_URL`,
     `CLERK_TENANT_AUDIENCE`, and `CLERK_PLATFORM_AUDIENCE` to local and
     production `ai-worker` environments.
   - Existing service audiences, source subjects, and machine secrets remain
     destination-specific.
   - Added Compose regression coverage for all ten worker Clerk startup keys.

2. Clerk request identity mapping
   - App verifier extracts signed Clerk organization ID from `org_id` or `o.id`.
   - Auth plugin resolves signed `sub` plus organization ID through the
     application-owned mapping domain before tenant route handling.
   - Unknown, deleted, inactive, or non-member mappings fail closed.
   - Tenant route parameters are checked against resolved application tenant;
     caller path and browser/session storage context cannot select another
     tenant.
   - Integration-style authenticated request test proves signed Clerk
     principal resolves to application user/tenant IDs.

3. Webhook provisioning safety
   - User and organization webhook upserts update existing pre-provisioned rows
     only.
   - Unknown external identities are rejected instead of receiving random app
     UUIDs.
   - Event-id idempotency and deletion markers remain unchanged.
   - Unknown-identity rejection coverage added.

4. Foundry platform role isolation
   - Removed `org_role` and `o.rol` promotion into platform roles.
   - Platform authorization now accepts explicit `platform_role` or existing
     application-owned role arrays only.
   - Organization-member operator route regression now rejects.

5. Strict worker M2M cache validation
   - Before issuance result enters cache, validates JWT header `alg=RS256`,
     configured exact issuer, singleton exact target audience, exact source
     subject, required scopes, numeric future-valid `exp`/`nbf`, and non-empty
     `jti`.
   - Receiving services still perform signature verification.
   - App and Foundry worker clients pass configured issuer independently.

6. Office tax loader stability
   - Replaced render-created tax callback with module-level `loadTaxForOffice`.
   - Added loader regression coverage; `OfficeData` no longer refetches because
     tax page callback identity changes after each state update.

7. Publishable-key fail-closed behavior
   - Removed hardcoded publishable-key fallbacks from Capture, Office, and
     Foundry layouts.
   - Added shared local helper behavior per frontend: missing or blank
     `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` throws a clear configuration error.
   - Tests keep configurable fake keys in test fixtures only.

## Verification

- Focused App API auth: 56 passed.
- Focused Foundry auth: 63 passed.
- Focused worker strict M2M: 15 passed.
- Focused webhook: 11 passed.
- Focused Compose boundary: 4 passed.
- Full JS workspace tests: contracts 54, App API 220, Foundry 100, Capture 8, Office 12, Foundry Web 12; all passed.
- Full Python tests: expense contracts 5, AI worker 49; all passed.
- JS lint: passed.
- Python Ruff check and format check: passed.
- JS typecheck: passed.
- `git diff --check`: passed.
- Production builds with configured test-only publishable key: contracts, App API, Foundry, Capture, Office, Foundry Web all passed.
- Build without publishable key failed at layout prerender with expected `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required`, proving fail-fast behavior.

## Boundaries

- No browser, dashboard, external API, deploy, push, DNS, or production
  activation performed.
- Build validation used `pk_test_configured` only as process environment input;
  no secret or real Clerk credential was added to repository files.
